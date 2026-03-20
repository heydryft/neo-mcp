/**
 * SQLite database for Neo MCP.
 * Stores: credentials, collections (agent-designed tables), custom tools.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";

const DATA_DIR = join(homedir(), ".neo-mcp");
let db: Database.Database | null = null;

export function getDb(): Database.Database {
    if (db) return db;

    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

    db = new Database(join(DATA_DIR, "neo-mcp.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Schema
    db.exec(`
        CREATE TABLE IF NOT EXISTS credentials (
            service TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (service, key)
        );

        CREATE TABLE IF NOT EXISTS _collections (
            name TEXT PRIMARY KEY,
            description TEXT,
            columns TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS custom_tools (
            name TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            params_schema TEXT NOT NULL DEFAULT '{}',
            code TEXT NOT NULL,
            service TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);

    return db;
}

// ── Credentials ──────────────────────────────────────────────────────────────

export function storeCredential(service: string, key: string, value: string): void {
    getDb().prepare(
        `INSERT INTO credentials (service, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(service, key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`
    ).run(service, key, value);
}

export function getCredentials(service: string): Record<string, string> {
    const rows = getDb()
        .prepare("SELECT key, value FROM credentials WHERE service=?")
        .all(service) as Array<{ key: string; value: string }>;
    const creds: Record<string, string> = {};
    for (const row of rows) creds[row.key] = row.value;
    return creds;
}

export function getStoredCredential(service: string, key: string): string | null {
    const row = getDb()
        .prepare("SELECT value FROM credentials WHERE service=? AND key=?")
        .get(service, key) as any;
    return row?.value || null;
}

export function listConnectedServices(): Array<{ service: string; keys: string[]; updatedAt: string }> {
    const rows = getDb()
        .prepare(
            `SELECT service, GROUP_CONCAT(key) as keys, MAX(updated_at) as updated_at
             FROM credentials GROUP BY service ORDER BY service`
        )
        .all() as any[];
    return rows.map((r) => ({
        service: r.service,
        keys: r.keys.split(","),
        updatedAt: r.updated_at,
    }));
}

export function listProfiles(service: string): Array<{ profile: string; keys: string[]; updatedAt: string }> {
    const rows = getDb()
        .prepare(
            `SELECT service, GROUP_CONCAT(key) as keys, MAX(updated_at) as updated_at
             FROM credentials WHERE service = ? OR service LIKE ?
             GROUP BY service ORDER BY service`
        )
        .all(service, `${service}:%`) as any[];
    return rows.map((r) => ({
        profile: r.service === service ? "default" : r.service.slice(service.length + 1),
        keys: r.keys.split(","),
        updatedAt: r.updated_at,
    }));
}

// ── Collections ──────────────────────────────────────────────────────────────

export interface CollectionColumn {
    name: string;
    type: "text" | "number" | "boolean" | "date" | "json";
    description?: string;
}

interface CollectionSchema {
    name: string;
    description: string;
    columns: CollectionColumn[];
}

function getCollectionSchema(tableName: string): CollectionSchema | null {
    const row = getDb().prepare("SELECT * FROM _collections WHERE name = ?").get(tableName) as any;
    if (!row) return null;
    return { name: row.name, description: row.description, columns: JSON.parse(row.columns) };
}

const TYPE_MAP: Record<string, string> = {
    text: "TEXT", number: "REAL", boolean: "INTEGER", date: "TEXT", json: "TEXT",
};

export function createCollection(name: string, description: string, columns: CollectionColumn[]): string {
    const d = getDb();
    const tableName = `c_${name.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;

    const existing = d.prepare("SELECT name FROM _collections WHERE name = ?").get(tableName);
    if (existing) throw new Error(`Collection "${name}" already exists.`);

    const colDefs = [
        "id INTEGER PRIMARY KEY AUTOINCREMENT",
        ...columns.map((c) => `${c.name} ${TYPE_MAP[c.type] || "TEXT"}`),
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))",
        "updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
    ];

    d.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${colDefs.join(", ")})`);
    d.prepare("INSERT INTO _collections (name, description, columns) VALUES (?, ?, ?)").run(tableName, description, JSON.stringify(columns));

    // FTS index on text columns
    const textCols = columns.filter((c) => c.type === "text").map((c) => c.name);
    if (textCols.length > 0) {
        try {
            d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName}_fts USING fts5(${textCols.join(", ")}, content=${tableName}, content_rowid=rowid)`);
            d.exec(`CREATE TRIGGER IF NOT EXISTS ${tableName}_fts_insert AFTER INSERT ON ${tableName} BEGIN
                INSERT INTO ${tableName}_fts(rowid, ${textCols.join(", ")}) VALUES (new.rowid, ${textCols.map((c) => `new.${c}`).join(", ")});
            END`);
        } catch {}
    }

    return `Created collection "${name}" with ${columns.length} columns.`;
}

export function listCollections(): CollectionSchema[] {
    const rows = getDb().prepare("SELECT * FROM _collections ORDER BY name").all() as any[];
    return rows.map((r) => ({ name: r.name, description: r.description, columns: JSON.parse(r.columns) }));
}

export function collectionInsert(collection: string, data: Record<string, any>): { id: number } {
    const tableName = collection.startsWith("c_") ? collection : `c_${collection.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
    const schema = getCollectionSchema(tableName);
    if (!schema) throw new Error(`Collection "${collection}" not found.`);

    const cols = schema.columns.filter((c) => data[c.name] !== undefined);
    const colNames = cols.map((c) => c.name);
    const values = cols.map((c) => {
        const v = data[c.name];
        if (c.type === "json" && typeof v === "object") return JSON.stringify(v);
        if (c.type === "boolean") return v ? 1 : 0;
        return v;
    });
    const placeholders = cols.map(() => "?").join(", ");

    const result = getDb()
        .prepare(`INSERT INTO ${tableName} (${colNames.join(", ")}) VALUES (${placeholders})`)
        .run(...values);
    return { id: result.lastInsertRowid as number };
}

export function collectionUpdate(collection: string, id: number, data: Record<string, any>): boolean {
    const tableName = collection.startsWith("c_") ? collection : `c_${collection.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
    const schema = getCollectionSchema(tableName);
    if (!schema) throw new Error(`Collection "${collection}" not found.`);

    const cols = schema.columns.filter((c) => data[c.name] !== undefined);
    if (cols.length === 0) return false;

    const sets = cols.map((c) => `${c.name} = ?`);
    sets.push("updated_at = datetime('now')");
    const values = cols.map((c) => {
        const v = data[c.name];
        if (c.type === "json" && typeof v === "object") return JSON.stringify(v);
        if (c.type === "boolean") return v ? 1 : 0;
        return v;
    });
    values.push(id as any);

    const result = getDb()
        .prepare(`UPDATE ${tableName} SET ${sets.join(", ")} WHERE id = ?`)
        .run(...values);
    return result.changes > 0;
}

export function collectionDelete(collection: string, id: number): boolean {
    const tableName = collection.startsWith("c_") ? collection : `c_${collection.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
    const result = getDb().prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
    return result.changes > 0;
}

export function collectionQuery(
    collection: string,
    opts: { search?: string; where?: Record<string, any>; orderBy?: string; limit?: number; offset?: number } = {}
): any[] {
    const tableName = collection.startsWith("c_") ? collection : `c_${collection.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
    const schema = getCollectionSchema(tableName);
    if (!schema) throw new Error(`Collection "${collection}" not found.`);

    let query: string;
    const params: any[] = [];

    if (opts.search) {
        try {
            query = `SELECT t.* FROM ${tableName} t JOIN ${tableName}_fts f ON t.rowid = f.rowid WHERE ${tableName}_fts MATCH ?`;
            params.push(opts.search);
        } catch {
            query = `SELECT * FROM ${tableName} WHERE 1=1`;
        }
    } else {
        query = `SELECT * FROM ${tableName} WHERE 1=1`;
    }

    if (opts.where) {
        for (const [key, value] of Object.entries(opts.where)) {
            query += ` AND ${key} = ?`;
            params.push(value);
        }
    }

    query += ` ORDER BY ${opts.orderBy || "id DESC"}`;
    query += ` LIMIT ${opts.limit || 50}`;
    if (opts.offset) query += ` OFFSET ${opts.offset}`;

    return getDb().prepare(query).all(...params) as any[];
}

// ── Custom Tools ─────────────────────────────────────────────────────────────

export interface CustomTool {
    name: string;
    description: string;
    params_schema: string;
    code: string;
    service?: string;
    created_at: string;
    updated_at: string;
}

export function saveCustomTool(name: string, description: string, paramsSchema: Record<string, string>, code: string, service?: string): void {
    getDb().prepare(
        `INSERT INTO custom_tools (name, description, params_schema, code, service, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET description=excluded.description, params_schema=excluded.params_schema,
         code=excluded.code, service=excluded.service, updated_at=datetime('now')`
    ).run(name, description, JSON.stringify(paramsSchema), code, service || null);
}

export function getCustomTools(): CustomTool[] {
    return getDb().prepare("SELECT * FROM custom_tools ORDER BY name").all() as CustomTool[];
}

export function getCustomTool(name: string): CustomTool | null {
    return (getDb().prepare("SELECT * FROM custom_tools WHERE name=?").get(name) as CustomTool) || null;
}

export function deleteCustomTool(name: string): boolean {
    const result = getDb().prepare("DELETE FROM custom_tools WHERE name=?").run(name);
    return result.changes > 0;
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

export function closeDb(): void {
    if (db) { db.close(); db = null; }
}

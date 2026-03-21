/**
 * Google Drive integration for Neo MCP via OAuth 2.0.
 *
 * Reuses the same Google OAuth client credentials as Gmail.
 * Supports multiple accounts via the profile system.
 */

import { getClientId, getClientSecret } from "./gmail.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

export interface GDriveAuth {
    access_token: string;
}

// ── Token Management ─────────────────────────────────────────────────────────

export const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function getOAuthUrl(redirectUri: string, profile?: string): string {
    const params = new URLSearchParams({
        client_id: getClientId(),
        redirect_uri: redirectUri,
        response_type: "code",
        scope: [
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/drive.file",
        ].join(" "),
        access_type: "offline",
        prompt: "consent",
        state: profile || "default",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
}> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: getClientId(),
            client_secret: getClientSecret(),
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
        }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`OAuth token exchange failed: ${JSON.stringify(data)}`);
    return data as any;
}

export async function refreshAccessToken(refreshToken: string, profile = "default"): Promise<string> {
    const cached = tokenCache.get(profile);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            refresh_token: refreshToken,
            client_id: getClientId(),
            client_secret: getClientSecret(),
            grant_type: "refresh_token",
        }),
    });
    const data: any = await res.json();
    if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);

    tokenCache.set(profile, {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    });
    return data.access_token;
}

// ── API wrapper ──────────────────────────────────────────────────────────────

async function driveApi<T = any>(
    auth: GDriveAuth,
    path: string,
    options: { method?: string; body?: any; params?: Record<string, string>; rawResponse?: boolean } = {}
): Promise<T> {
    const url = new URL(`${DRIVE_API}${path}`);
    if (options.params) {
        for (const [k, v] of Object.entries(options.params)) url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {
        "Authorization": `Bearer ${auth.access_token}`,
        "Accept": "application/json",
    };
    if (options.body && typeof options.body === "string") {
        headers["Content-Type"] = "text/plain";
    } else if (options.body) {
        headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url.toString(), {
        method: options.method || "GET",
        headers,
        body: options.body
            ? typeof options.body === "string" ? options.body : JSON.stringify(options.body)
            : undefined,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Google Drive API ${res.status}: ${text.slice(0, 500)}`);
    }

    if (options.rawResponse) return res as unknown as T;

    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) return res.json() as Promise<T>;
    return (await res.text()) as unknown as T;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatFile(f: any): any {
    return {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: f.size ? Number(f.size) : undefined,
        createdTime: f.createdTime,
        modifiedTime: f.modifiedTime,
        parents: f.parents,
        webViewLink: f.webViewLink,
        iconLink: f.iconLink,
        shared: f.shared,
        trashed: f.trashed,
        owners: f.owners?.map((o: any) => o.emailAddress),
        starred: f.starred,
    };
}

const FILE_FIELDS = "id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,iconLink,shared,trashed,owners,starred";

// Google Workspace MIME → export MIME
const EXPORT_MAP: Record<string, { mime: string; ext: string }> = {
    "application/vnd.google-apps.document": { mime: "text/plain", ext: "txt" },
    "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: "csv" },
    "application/vnd.google-apps.presentation": { mime: "text/plain", ext: "txt" },
    "application/vnd.google-apps.drawing": { mime: "image/png", ext: "png" },
};

// ── Files ────────────────────────────────────────────────────────────────────

export async function listFiles(
    auth: GDriveAuth,
    options: { query?: string; pageSize?: number; orderBy?: string; folderId?: string; pageToken?: string } = {}
): Promise<{ files: any[]; nextPageToken?: string }> {
    const params: Record<string, string> = {
        pageSize: String(options.pageSize || 20),
        fields: `nextPageToken,files(${FILE_FIELDS})`,
    };
    if (options.orderBy) params.orderBy = options.orderBy;

    const parts: string[] = ["trashed = false"];
    if (options.folderId) parts.push(`'${options.folderId}' in parents`);
    if (options.query) parts.push(options.query);
    params.q = parts.join(" and ");

    if (options.pageToken) params.pageToken = options.pageToken;

    const data = await driveApi<any>(auth, "/files", { params });
    return {
        files: (data.files || []).map(formatFile),
        nextPageToken: data.nextPageToken,
    };
}

export async function getFile(auth: GDriveAuth, fileId: string): Promise<any> {
    const data = await driveApi(auth, `/files/${encodeURIComponent(fileId)}`, {
        params: { fields: FILE_FIELDS },
    });
    return formatFile(data);
}

export async function searchFiles(
    auth: GDriveAuth,
    query: string,
    pageSize = 20
): Promise<any[]> {
    const params: Record<string, string> = {
        pageSize: String(pageSize),
        fields: `files(${FILE_FIELDS})`,
        q: `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
    };
    const data = await driveApi<any>(auth, "/files", { params });
    return (data.files || []).map(formatFile);
}

export async function getFileContent(auth: GDriveAuth, fileId: string): Promise<string> {
    // First get metadata to determine type
    const meta = await driveApi<any>(auth, `/files/${encodeURIComponent(fileId)}`, {
        params: { fields: "mimeType,name" },
    });

    const exportInfo = EXPORT_MAP[meta.mimeType];
    if (exportInfo) {
        // Google Workspace file → export
        const params = new URLSearchParams({ mimeType: exportInfo.mime });
        const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?${params}`;
        const res = await fetch(url, {
            headers: { "Authorization": `Bearer ${auth.access_token}` },
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Drive export ${res.status}: ${text.slice(0, 500)}`);
        }
        // For drawings (PNG), return base64
        if (exportInfo.mime.startsWith("image/")) {
            const buf = await res.arrayBuffer();
            return `data:${exportInfo.mime};base64,${Buffer.from(buf).toString("base64")}`;
        }
        return res.text();
    }

    // Regular file → download
    const data = await driveApi<string>(auth, `/files/${encodeURIComponent(fileId)}`, {
        params: { alt: "media" },
    });
    return data;
}

export async function createFile(
    auth: GDriveAuth,
    name: string,
    content: string,
    mimeType = "text/plain",
    folderId?: string
): Promise<any> {
    const metadata: any = { name, mimeType };
    if (folderId) metadata.parents = [folderId];

    const boundary = `neo_boundary_${Date.now()}`;
    const body =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n` +
        `${content}\r\n` +
        `--${boundary}--`;

    const res = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${FILE_FIELDS}`,
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${auth.access_token}`,
                "Content-Type": `multipart/related; boundary=${boundary}`,
            },
            body,
        }
    );
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Drive create ${res.status}: ${text.slice(0, 500)}`);
    }
    return formatFile(await res.json());
}

export async function updateFile(
    auth: GDriveAuth,
    fileId: string,
    content: string,
    mimeType = "text/plain"
): Promise<any> {
    const res = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=${FILE_FIELDS}`,
        {
            method: "PATCH",
            headers: {
                "Authorization": `Bearer ${auth.access_token}`,
                "Content-Type": mimeType,
            },
            body: content,
        }
    );
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Drive update ${res.status}: ${text.slice(0, 500)}`);
    }
    return formatFile(await res.json());
}

export async function deleteFile(auth: GDriveAuth, fileId: string): Promise<void> {
    await driveApi(auth, `/files/${encodeURIComponent(fileId)}`, {
        method: "PATCH",
        body: { trashed: true },
    });
}

export async function createFolder(
    auth: GDriveAuth,
    name: string,
    parentId?: string
): Promise<any> {
    const metadata: any = {
        name,
        mimeType: "application/vnd.google-apps.folder",
    };
    if (parentId) metadata.parents = [parentId];

    const data = await driveApi(auth, "/files", {
        method: "POST",
        body: metadata,
        params: { fields: FILE_FIELDS },
    });
    return formatFile(data);
}

// ── Shared Drives ────────────────────────────────────────────────────────────

export async function listSharedDrives(auth: GDriveAuth): Promise<any[]> {
    const data = await driveApi<any>(auth, "/drives", {
        params: { pageSize: "100" },
    });
    return (data.drives || []).map((d: any) => ({
        id: d.id,
        name: d.name,
        createdTime: d.createdTime,
        hidden: d.hidden,
    }));
}

// ── Storage Quota ────────────────────────────────────────────────────────────

export async function getStorageQuota(auth: GDriveAuth): Promise<any> {
    const data = await driveApi<any>(auth, "/about", {
        params: { fields: "storageQuota,user" },
    });
    const q = data.storageQuota || {};
    return {
        limit: q.limit ? Number(q.limit) : undefined,
        usage: q.usage ? Number(q.usage) : 0,
        usageInDrive: q.usageInDrive ? Number(q.usageInDrive) : 0,
        usageInDriveTrash: q.usageInDriveTrash ? Number(q.usageInDriveTrash) : 0,
        user: data.user?.emailAddress,
    };
}

/**
 * SQLite database for Neo MCP.
 * Stores: credentials, collections (agent-designed tables), custom tools.
 */
import Database from "better-sqlite3";
export declare function getDb(): Database.Database;
export declare function storeCredential(service: string, key: string, value: string): void;
export declare function getCredentials(service: string): Record<string, string>;
export declare function getStoredCredential(service: string, key: string): string | null;
export declare function listConnectedServices(): Array<{
    service: string;
    keys: string[];
    updatedAt: string;
}>;
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
export declare function createCollection(name: string, description: string, columns: CollectionColumn[]): string;
export declare function listCollections(): CollectionSchema[];
export declare function collectionInsert(collection: string, data: Record<string, any>): {
    id: number;
};
export declare function collectionUpdate(collection: string, id: number, data: Record<string, any>): boolean;
export declare function collectionDelete(collection: string, id: number): boolean;
export declare function collectionQuery(collection: string, opts?: {
    search?: string;
    where?: Record<string, any>;
    orderBy?: string;
    limit?: number;
    offset?: number;
}): any[];
export interface CustomTool {
    name: string;
    description: string;
    params_schema: string;
    code: string;
    service?: string;
    created_at: string;
    updated_at: string;
}
export declare function saveCustomTool(name: string, description: string, paramsSchema: Record<string, string>, code: string, service?: string): void;
export declare function getCustomTools(): CustomTool[];
export declare function getCustomTool(name: string): CustomTool | null;
export declare function deleteCustomTool(name: string): boolean;
export declare function closeDb(): void;
export {};

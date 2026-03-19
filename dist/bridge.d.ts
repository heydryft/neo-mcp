/**
 * WebSocket bridge to the Neo Browser Extension.
 * The Chrome extension connects here. MCP server sends commands, gets results.
 */
export declare function startBridge(port?: number): void;
export declare function isBridgeConnected(): boolean;
export declare function browserCommand(method: string, params?: Record<string, any>, timeoutMs?: number): Promise<any>;

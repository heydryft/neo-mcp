/**
 * WebSocket bridge to the Neo Browser Extension.
 * The Chrome extension connects here. MCP server sends commands, gets results.
 */
import { WebSocketServer, WebSocket } from "ws";
const DEFAULT_PORT = 7890;
let wss = null;
let extensionSocket = null;
let pendingRequests = new Map();
let nextId = 1;
export function startBridge(port = DEFAULT_PORT) {
    if (wss)
        return;
    wss = new WebSocketServer({ host: "127.0.0.1", port });
    wss.on("connection", (ws) => {
        console.error("[neo-mcp] Browser extension connected");
        extensionSocket = ws;
        ws.on("message", (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            }
            catch {
                return;
            }
            if (msg.id && pendingRequests.has(msg.id)) {
                const pending = pendingRequests.get(msg.id);
                pendingRequests.delete(msg.id);
                clearTimeout(pending.timer);
                if (msg.error) {
                    pending.reject(new Error(msg.error.message || "Bridge error"));
                }
                else {
                    pending.resolve(msg.result);
                }
                return;
            }
        });
        ws.on("close", () => {
            console.error("[neo-mcp] Browser extension disconnected");
            if (extensionSocket === ws)
                extensionSocket = null;
            for (const [, pending] of pendingRequests) {
                clearTimeout(pending.timer);
                pending.reject(new Error("Extension disconnected"));
            }
            pendingRequests.clear();
        });
        ws.on("error", () => { });
    });
    wss.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
            console.error(`[neo-mcp] Port ${port} in use. Is another instance running?`);
        }
    });
    console.error(`[neo-mcp] Bridge listening on ws://127.0.0.1:${port}`);
}
export function isBridgeConnected() {
    return extensionSocket !== null && extensionSocket.readyState === WebSocket.OPEN;
}
export function browserCommand(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
            reject(new Error("Browser extension not connected. Make sure Chrome is running with the Neo Bridge extension."));
            return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`Browser command "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pendingRequests.set(id, { resolve, reject, timer });
        extensionSocket.send(JSON.stringify({ id, method, params }));
    });
}
//# sourceMappingURL=bridge.js.map
/**
 * Neo Bridge - Background Service Worker
 *
 * Maintains WebSocket connection to Neo daemon.
 * Dispatches browser control commands. Auto-extracts auth tokens.
 */

const NEO_WS_URL = "ws://127.0.0.1:7890";
const NEO_MCP_URL = "http://127.0.0.1:3100/mcp";
const RECONNECT_INTERVAL = 3000;
const HEARTBEAT_INTERVAL = 30000;

let ws = null;
let connected = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let pendingContentRequests = new Map();
let requestId = 0;
let mcpSessionId = null; // Tracks MCP HTTP session for Cowork relay

// ── Native Messaging: Auto-launch MCP server ────────────────────────────────
// Chrome Native Messaging spawns the MCP server when the extension loads.
// The server stays alive as long as Chrome is open. No manual "node server.js" needed.
const NATIVE_HOST_NAME = "com.neo.bridge";
let nativePort = null;
let mcpServerReady = false;

function connectNativeHost() {
    if (nativePort) return;
    try {
        nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

        nativePort.onMessage.addListener((msg) => {
            if (msg.type === "server_ready") {
                mcpServerReady = true;
                console.log("[neo] MCP server auto-started on port", msg.port);
                updateBadge("ON", "#22c55e");
            } else if (msg.type === "server_exited") {
                mcpServerReady = false;
                console.warn("[neo] MCP server exited with code", msg.code);
            } else if (msg.type === "host_started") {
                console.log("[neo] Native host connected — launching MCP server...");
            }
        });

        nativePort.onDisconnect.addListener(() => {
            const err = chrome.runtime.lastError?.message || "unknown";
            nativePort = null;
            mcpServerReady = false;
            // Don't spam reconnect — native host not installed is a permanent condition
            if (err.includes("not found") || err.includes("Specified native messaging host not found")) {
                console.warn("[neo] Native messaging host not installed. Run `npm install` in the neo-mcp folder to set it up.");
            } else {
                console.warn("[neo] Native host disconnected:", err);
                // Retry after a delay (server crash, etc.)
                setTimeout(connectNativeHost, 5000);
            }
        });
    } catch (e) {
        console.warn("[neo] Native messaging unavailable:", e.message);
    }
}

// Auto-connect on extension startup
connectNativeHost();

// ── Tab group management ─────────────────────────────────────────────────────
// Neo gets its own tab group. Never touches user tabs.
let neoGroupId = null;       // chrome tab group ID
let neoTabIds = new Set();   // tabs owned by Neo

// ── Network capture state ────────────────────────────────────────────────────
let networkCapture = {
    active: false,
    filters: [],        // url patterns to match
    requests: [],       // captured entries
    maxEntries: 500,
};

// ── WebSocket Connection ─────────────────────────────────────────────────────

function connect() {
    if (ws && ws.readyState <= 1) return; // already connected/connecting

    try {
        ws = new WebSocket(NEO_WS_URL);
    } catch (e) {
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        connected = true;
        clearTimeout(reconnectTimer);
        updateBadge("ON", "#22c55e");
        console.log("[neo] Connected to daemon");

        // Send capabilities
        send({
            event: "bridge_connected",
            capabilities: [
                "navigate", "get_url", "get_tabs", "new_tab", "close_tab", "close_all_tabs", "switch_tab",
                "go_back", "go_forward", "reload", "get_profile",
                "click", "type", "clear", "select", "scroll", "focus",
                "read_text", "read_html", "read_page", "scroll_collect", "read_attribute", "read_value",
                "query_selector", "query_selector_all", "wait_for",
                "screenshot", "screenshot_full",
                "extract_cookies", "extract_local_storage", "extract_session_storage",
                "extract_auth", "set_cookie",
                "execute_js",
                "get_history", "download",
                "get_page_info",
                "network_start_capture", "network_stop_capture", "network_list", "network_get_request", "network_get_requests", "network_get_headers", "network_clear",
                "browser_fetch",
            ],
        });

        startHeartbeat();
    };

    ws.onmessage = async (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }

        if (msg.id && msg.method) {
            // Command from daemon
            try {
                const result = await handleCommand(msg.method, msg.params || {});
                send({ id: msg.id, result });
            } catch (err) {
                send({ id: msg.id, error: { message: err.message || String(err) } });
            }
        }
    };

    ws.onclose = () => {
        connected = false;
        updateBadge("OFF", "#666");
        stopHeartbeat();
        scheduleReconnect();
    };

    ws.onerror = () => {
        // onclose will fire after this
    };
}

function send(data) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(data));
    }
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_INTERVAL);
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => send({ event: "heartbeat" }), HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
}

function updateBadge(text, color) {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
}

// Keep service worker alive
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive") {
        if (!connected) connect();
    }
});

// Connect on install/startup
chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());

// Also try connecting immediately
connect();

// ── Command Dispatcher ───────────────────────────────────────────────────────

async function handleCommand(method, params) {
    switch (method) {
        // ── Navigation (all tabs created by Neo go into the Neo tab group) ──
        case "navigate":
            // If called via Cowork relay, navigate the current tab instead of creating a new Neo tab
            if (params._relay_tab_id) return neoNavigateTab(params.url, params._relay_tab_id);
            return neoNavigate(params.url);
        case "get_url":
            if (params._relay_tab_id) {
                try {
                    const t = await chrome.tabs.get(params._relay_tab_id);
                    return { tab_id: t.id, url: t.url, title: t.title };
                } catch {}
            }
            return getNeoActiveTab();
        case "get_tabs":
            return getNeoTabs();
        case "new_tab":
            return neoNewTab(params.url);
        case "close_tab":
            return neoCloseTab(params.tab_id);
        case "close_all_tabs":
            return neoCloseAllTabs();
        case "switch_tab":
            return neoSwitchTab(params.tab_id);
        case "navigate_tab":
            return neoNavigateTab(params.url, params.tab_id);
        case "go_back":
            return execOnNeoTab("history.back()", params._relay_tab_id);
        case "go_forward":
            return execOnNeoTab("history.forward()", params._relay_tab_id);
        case "get_profile":
            return getProfile();
        case "reload":
            return reloadTab(params.tab_id || params._relay_tab_id);

        // ── DOM Interaction ──────────────────────────────────────────
        case "click":
            return contentCommand("click", params);
        case "type":
            return contentCommand("type", params);
        case "press_key":
            return contentCommand("press_key", params);
        case "clear":
            return contentCommand("clear", params);
        case "select":
            return contentCommand("select", params);
        case "check":
            return contentCommand("check", params);
        case "scroll":
            return contentCommand("scroll", params);
        case "focus":
            return contentCommand("focus", params);
        case "hover":
            return contentCommand("hover", params);
        case "drag_drop":
            return contentCommand("drag_drop", params);

        // ── DOM Reading ──────────────────────────────────────────────
        case "read_text":
            return contentCommand("read_text", params);
        case "read_html":
            return contentCommand("read_html", params);
        case "read_page":
            return contentCommand("read_page", params);
        case "scroll_collect":
            return contentCommand("scroll_collect", params);
        case "read_attribute":
            return contentCommand("read_attribute", params);
        case "read_value":
            return contentCommand("read_value", params);
        case "query_selector":
            return contentCommand("query_selector", params);
        case "query_selector_all":
            return contentCommand("query_selector_all", params);
        case "wait_for":
            return contentCommand("wait_for", params);
        case "wait_for_navigation":
            return contentCommand("wait_for_navigation", params);
        case "get_page_info":
            return contentCommand("get_page_info", params);

        // ── Screenshots ──────────────────────────────────────────────
        case "screenshot":
            return screenshot(params.quality, params._relay_tab_id);
        case "screenshot_full":
            return contentCommand("screenshot_full", params);

        // ── Auth / Cookies ───────────────────────────────────────────
        case "extract_cookies":
            return extractCookies(params.domain, params.names);
        case "extract_local_storage":
            return contentCommand("extract_local_storage", params);
        case "extract_session_storage":
            return contentCommand("extract_session_storage", params);
        case "extract_auth":
            return extractAuth(params.service);
        case "set_cookie":
            return setCookie(params);

        // ── JavaScript execution ─────────────────────────────────────
        case "execute_js":
            return execJsInPage(params.code, params.tab_id);

        // ── History ──────────────────────────────────────────────────
        case "get_history":
            return getHistory(params.max_results || 50);

        // ── Downloads ────────────────────────────────────────────────
        case "download":
            return download(params.url, params.filename);

        // ── Network capture ──────────────────────────────────────────
        case "network_start_capture":
            return networkStartCapture(params.filters, params.max_entries);
        case "network_stop_capture":
            return networkStopCapture();
        case "network_list":
            return networkList(params.filter, params.limit, params.offset);
        case "network_get_request":
            return networkGetRequest(params.id);
        case "network_get_requests":
            return networkGetRequests(params.ids);
        case "network_get_headers":
            return networkGetHeaders(params.id);
        case "network_clear":
            return networkClear();

        // ── Browser-context fetch ────────────────────────────────────
        case "browser_fetch":
            return browserFetch(params);

        // ── MCP Server relay (Cowork → localhost MCP server) ─────────
        case "mcp_request":
            return mcpRequest(params);
        case "mcp_tools_list":
            return mcpToolsList();
        case "mcp_tool_call":
            return mcpToolCall(params.name, params.arguments || {});

        // ── Diagnostics ──────────────────────────────────────────────
        case "neo_status":
            return {
                nativePort: !!nativePort,
                mcpServerReady,
                mcpSessionId: mcpSessionId || null,
                wsConnected: connected,
                extensionId: chrome.runtime.id,
                mcpUrl: NEO_MCP_URL,
            };

        // Raw fetch debug — test MCP server and return ALL headers
        case "mcp_debug_fetch": {
            try {
                const hdrs = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
                if (mcpSessionId) hdrs["mcp-session-id"] = mcpSessionId;
                const r = await fetch(NEO_MCP_URL, { method: "POST", headers: hdrs,
                    body: JSON.stringify(params.message || { jsonrpc: "2.0", id: "dbg", method: "initialize",
                        params: { protocolVersion: "2024-11-05", capabilities: {},
                            clientInfo: { name: "dbg", version: "1.0" } } }) });
                const respHeaders = {};
                r.headers.forEach((v, k) => { respHeaders[k] = v; });
                const body = await r.text();
                return { status: r.status, headers: respHeaders, body: body.slice(0, 500), sentSessionId: mcpSessionId };
            } catch (e) { return { error: e.message }; }
        }

        default:
            throw new Error(`Unknown method: ${method}`);
    }
}

// ── Tab Group Management ─────────────────────────────────────────────────────
// Neo works in its own tab group. Never touches user tabs.

// Edge doesn't support chrome.tabGroups — detect once at startup
const hasTabGroups = typeof chrome.tabGroups !== "undefined";

async function ensureNeoGroup() {
    if (!hasTabGroups) return null;

    // Check if our group still exists
    if (neoGroupId !== null) {
        try {
            const group = await chrome.tabGroups.get(neoGroupId);
            if (group) return neoGroupId;
        } catch {
            neoGroupId = null;
        }
    }

    // Check for existing Neo group (extension might have restarted)
    const allGroups = await chrome.tabGroups.query({ title: "Neo" });
    if (allGroups.length > 0) {
        neoGroupId = allGroups[0].id;
        // Rebuild neoTabIds from existing group
        const tabs = await chrome.tabs.query({ groupId: neoGroupId });
        neoTabIds = new Set(tabs.map((t) => t.id));
        return neoGroupId;
    }

    // Create a new tab to seed the group
    const seedTab = await chrome.tabs.create({ url: "about:blank", active: false });
    neoGroupId = await chrome.tabs.group({ tabIds: [seedTab.id] });
    await chrome.tabGroups.update(neoGroupId, { title: "Neo", color: "blue", collapsed: false });
    neoTabIds.add(seedTab.id);
    return neoGroupId;
}

async function addTabToNeoGroup(tabId) {
    if (!hasTabGroups) { neoTabIds.add(tabId); return; }
    const groupId = await ensureNeoGroup();
    try {
        await chrome.tabs.group({ tabIds: [tabId], groupId });
    } catch {}
    neoTabIds.add(tabId);
}

function isNeoTab(tabId) {
    return neoTabIds.has(tabId);
}

// Clean up: when a Neo tab is closed externally, remove from tracking
chrome.tabs.onRemoved.addListener((tabId) => {
    neoTabIds.delete(tabId);
});

// ── Navigation (all Neo tabs live in the Neo tab group) ──────────────────────

async function neoNavigate(url) {
    // Always create a new tab. Agents close their tabs when done.
    // This prevents concurrent agents from overwriting each other's pages.
    const tab = await chrome.tabs.create({ url, active: true });
    const tabId = tab.id;
    await addTabToNeoGroup(tabId);

    return new Promise((resolve) => {
        chrome.tabs.onUpdated.addListener(function listener(tid, info) {
            if (tid === tabId && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                chrome.tabs.get(tid).then((t) => resolve({ tab_id: t.id, url: t.url, title: t.title }));
            }
        });
    });
}

async function neoNavigateTab(url, tabId) {
    // Navigate an existing tab to a new URL (tab reuse)
    await chrome.tabs.update(tabId, { url, active: true });
    return new Promise((resolve) => {
        chrome.tabs.onUpdated.addListener(function listener(tid, info) {
            if (tid === tabId && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                chrome.tabs.get(tid).then((t) => resolve({ tab_id: t.id, url: t.url, title: t.title }));
            }
        });
    });
}

async function getNeoActiveTab() {
    // Return the most recently active Neo tab
    for (const id of Array.from(neoTabIds).reverse()) {
        try {
            const tab = await chrome.tabs.get(id);
            if (tab) return { tab_id: tab.id, url: tab.url, title: tab.title };
        } catch {
            neoTabIds.delete(id);
        }
    }
    return { tab_id: null, url: null, title: null };
}

async function getNeoTabs() {
    const tabs = [];
    for (const id of neoTabIds) {
        try {
            const tab = await chrome.tabs.get(id);
            tabs.push({ id: tab.id, url: tab.url, title: tab.title, active: tab.active });
        } catch {
            neoTabIds.delete(id);
        }
    }
    return tabs;
}

async function neoNewTab(url) {
    const tab = await chrome.tabs.create({ url: url || "about:blank", active: true });
    await addTabToNeoGroup(tab.id);
    return { tab_id: tab.id };
}

async function neoCloseTab(tabId) {
    // Only close Neo-owned tabs
    if (tabId && !isNeoTab(tabId)) {
        return { error: "Cannot close user tabs. Only Neo-owned tabs can be closed." };
    }
    const id = tabId || Array.from(neoTabIds).pop();
    if (id) {
        neoTabIds.delete(id);
        await chrome.tabs.remove(id);
    }
    return { ok: true };
}

async function neoCloseAllTabs() {
    const ids = Array.from(neoTabIds);
    neoTabIds.clear();
    for (const id of ids) {
        try { await chrome.tabs.remove(id); } catch {}
    }
    neoGroupId = null;
    return { closed: ids.length };
}

async function neoSwitchTab(tabId) {
    await chrome.tabs.update(tabId, { active: true });
    return { ok: true };
}

async function reloadTab(tabId) {
    const id = tabId || Array.from(neoTabIds).pop();
    if (id) await chrome.tabs.reload(id);
    return { ok: true };
}

// ── Profile info ─────────────────────────────────────────────────────────────

function getProfile() {
    // chrome.identity or just return what we can infer
    return {
        // Each browser profile that has the extension installed gets its own service worker,
        // its own storage, its own WebSocket connection. Multiple profiles = multiple connections.
        extensionId: chrome.runtime.id,
        // User can label this profile via the popup or daemon config
        profileLabel: null, // TODO: make configurable via popup
    };
}

// ── Content Script Communication ─────────────────────────────────────────────

async function contentCommand(action, params) {
    // Default to the most recent Neo tab, not the user's active tab
    let tabId = params.tab_id;
    if (!tabId) {
        const neoTabs = Array.from(neoTabIds);
        for (let i = neoTabs.length - 1; i >= 0; i--) {
            try {
                const tab = await chrome.tabs.get(neoTabs[i]);
                if (tab && tab.url && !tab.url.startsWith("chrome://")) {
                    tabId = tab.id;
                    break;
                }
            } catch { neoTabIds.delete(neoTabs[i]); }
        }
    }
    if (!tabId) throw new Error("No Neo tab available. Use navigate to open one.");

    const results = await chrome.tabs.sendMessage(tabId, { action, params });
    if (results && results.error) throw new Error(results.error);
    return results;
}

async function execOnNeoTab(code, relayTabId) {
    let tabId = relayTabId || null;
    if (!tabId) {
        const neoTabs = Array.from(neoTabIds);
        for (let i = neoTabs.length - 1; i >= 0; i--) {
            try {
                const tab = await chrome.tabs.get(neoTabs[i]);
                if (tab) { tabId = tab.id; break; }
            } catch { neoTabIds.delete(neoTabs[i]); }
        }
    }
    if (!tabId) throw new Error("No Neo tab available.");

    // Use args-based execution to avoid CSP violations from string eval
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (codeStr) => {
            // Create a script element to bypass CSP for eval
            // This works because chrome.scripting runs in ISOLATED world by default
            try {
                const fn = new Function(codeStr);
                return fn();
            } catch (e) {
                // If Function constructor is blocked, try script injection
                return null;
            }
        },
        args: [code],
        world: "MAIN",
    });
    return { result: results[0]?.result };
}

/**
 * Execute JS in the page context, bypassing CSP.
 * Uses script element injection which works even on CSP-restricted pages
 * because chrome.scripting.executeScript with MAIN world is trusted.
 */
async function execJsInPage(code, tabId) {
    let id = tabId;
    if (!id) {
        const neoTabs = Array.from(neoTabIds);
        for (let i = neoTabs.length - 1; i >= 0; i--) {
            try {
                const tab = await chrome.tabs.get(neoTabs[i]);
                if (tab) { id = tab.id; break; }
            } catch { neoTabIds.delete(neoTabs[i]); }
        }
    }
    if (!id) throw new Error("No Neo tab available.");

    // Try MAIN world first (can access page JS globals like React, Angular, etc.)
    // then fall back to content script's ISOLATED world (immune to CSP but
    // can't see page JS variables — still has full DOM access).
    let results;
    try {
        results = await chrome.scripting.executeScript({
            target: { tabId: id },
            world: "MAIN",
            func: (codeStr) => {
                try {
                    const fn = new Function("return (" + codeStr + ")");
                    const result = fn();
                    return { result: result !== undefined ? JSON.parse(JSON.stringify(result)) : null };
                } catch (e) {
                    return { error: e.message || String(e) };
                }
            },
            args: [code],
        });
        // If MAIN world returned a CSP error, fall through to ISOLATED
        const r = results[0]?.result;
        if (r && r.error && /Content Security|EvalError|unsafe-eval/i.test(r.error)) {
            results = null;
        }
    } catch {
        results = null;
    }

    if (!results) {
        // Fallback: run in ISOLATED world (content script context, no CSP restrictions)
        results = await chrome.scripting.executeScript({
            target: { tabId: id },
            func: (codeStr) => {
                try {
                    const fn = new Function("return (" + codeStr + ")");
                    const result = fn();
                    return { result: result !== undefined ? JSON.parse(JSON.stringify(result)) : null };
                } catch (e) {
                    return { error: e.message || String(e) };
                }
            },
            args: [code],
        });
    }

    const r = results[0]?.result;
    if (r && r.error) return { error: r.error };
    return r || { result: null };
}

// ── Screenshots ──────────────────────────────────────────────────────────────

async function screenshot(quality, tabId) {
    // Low quality by default to keep context small
    // quality 20 JPEG at tab resolution ~= 15-30KB ~= 3-6K tokens
    // If tabId provided (e.g. from Cowork relay), activate that tab's window first
    let windowId = null;
    if (tabId) {
        try {
            const tab = await chrome.tabs.get(tabId);
            windowId = tab.windowId;
        } catch {}
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: quality || 20,
    });
    return { image: dataUrl, sizeKb: Math.round(dataUrl.length * 0.75 / 1024) };
}

// ── Cookies / Auth ───────────────────────────────────────────────────────────

async function extractCookies(domain, names) {
    const allCookies = await chrome.cookies.getAll({ domain: domain || undefined });
    if (names && names.length > 0) {
        return allCookies.filter((c) => names.includes(c.name)).map(cookieToObj);
    }
    return allCookies.map(cookieToObj);
}

function cookieToObj(c) {
    return { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate };
}

async function setCookie(params) {
    await chrome.cookies.set({
        url: params.url,
        name: params.name,
        value: params.value,
        domain: params.domain,
        path: params.path || "/",
        secure: params.secure,
        httpOnly: params.httpOnly,
    });
    return { ok: true };
}

/**
 * Smart auth extraction for known services.
 * Grabs the right tokens without the user having to know what to look for.
 */
async function extractAuth(service) {
    switch (service) {
        case "slack": {
            // Slack uses xoxc- token + d cookie
            const cookies = await chrome.cookies.getAll({ domain: ".slack.com" });
            const dCookie = cookies.find((c) => c.name === "d");
            // Also try to get the token from the active Slack tab
            const tabs = await chrome.tabs.query({ url: "*://*.slack.com/*" });
            let xoxcToken = null;
            if (tabs.length > 0) {
                try {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId: tabs[0].id },
                        func: () => {
                            // Try multiple extraction methods
                            // Method 1: boot_data in localStorage
                            for (let i = 0; i < localStorage.length; i++) {
                                const key = localStorage.key(i);
                                const val = localStorage.getItem(key);
                                if (val && val.includes("xoxc-")) {
                                    const match = val.match(/xoxc-[a-zA-Z0-9-]+/);
                                    if (match) return match[0];
                                }
                            }
                            // Method 2: global TS object
                            if (window.TS && window.TS.boot_data && window.TS.boot_data.api_token) {
                                return window.TS.boot_data.api_token;
                            }
                            return null;
                        },
                        world: "MAIN",
                    });
                    xoxcToken = results[0]?.result;
                } catch (e) { /* tab might not be accessible */ }
            }
            return {
                service: "slack",
                d_cookie: dCookie?.value || null,
                xoxc_token: xoxcToken,
                cookies: cookies.map(cookieToObj),
            };
        }

        case "discord": {
            // Discord token from localStorage
            const tabs = await chrome.tabs.query({ url: "*://discord.com/*" });
            let token = null;
            if (tabs.length > 0) {
                try {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId: tabs[0].id },
                        func: () => {
                            // Try webpack chunk extraction
                            try {
                                const iframe = document.createElement("iframe");
                                document.body.appendChild(iframe);
                                const token = iframe.contentWindow.localStorage.getItem("token");
                                iframe.remove();
                                if (token) return JSON.parse(token);
                            } catch {}
                            // Try direct localStorage
                            const t = localStorage.getItem("token");
                            if (t) return JSON.parse(t);
                            return null;
                        },
                        world: "MAIN",
                    });
                    token = results[0]?.result;
                } catch {}
            }
            return { service: "discord", token };
        }

        case "linkedin": {
            const cookies = await chrome.cookies.getAll({ domain: ".linkedin.com" });
            const liAt = cookies.find((c) => c.name === "li_at");
            const jsessionid = cookies.find((c) => c.name === "JSESSIONID");
            return {
                service: "linkedin",
                li_at: liAt?.value || null,
                jsessionid: jsessionid?.value?.replace(/"/g, "") || null,
            };
        }

        case "twitter":
        case "x": {
            const cookies = await chrome.cookies.getAll({ domain: ".x.com" });
            const authToken = cookies.find((c) => c.name === "auth_token");
            const ct0 = cookies.find((c) => c.name === "ct0");
            return {
                service: "twitter",
                auth_token: authToken?.value || null,
                csrf_token: ct0?.value || null,
            };
        }

        case "github": {
            const cookies = await chrome.cookies.getAll({ domain: ".github.com" });
            const session = cookies.find((c) => c.name === "user_session");
            return {
                service: "github",
                user_session: session?.value || null,
            };
        }

        case "notion": {
            const cookies = await chrome.cookies.getAll({ domain: ".notion.so" });
            const tokenV2 = cookies.find((c) => c.name === "token_v2");
            return {
                service: "notion",
                token_v2: tokenV2?.value || null,
            };
        }

        default: {
            // Generic: return all cookies for likely domains
            const domains = [`.${service}.com`, `.${service}.io`, `.${service}.ai`];
            const allCookies = [];
            for (const domain of domains) {
                const cookies = await chrome.cookies.getAll({ domain });
                allCookies.push(...cookies.map(cookieToObj));
            }
            return { service, cookies: allCookies };
        }
    }
}

// ── History ──────────────────────────────────────────────────────────────────

async function getHistory(maxResults) {
    const items = await chrome.history.search({ text: "", maxResults, startTime: 0 });
    return items.map((i) => ({ url: i.url, title: i.title, lastVisitTime: i.lastVisitTime, visitCount: i.visitCount }));
}

// ── Downloads ────────────────────────────────────────────────────────────────

async function download(url, filename) {
    const id = await chrome.downloads.download({ url, filename });
    return { download_id: id };
}

// ── Network Capture ──────────────────────────────────────────────────────────
// Intercepts HTTP requests. Stores summaries in a lightweight list,
// full headers/bodies stored separately so the agent can drill down lazily.

// Edge MV3 has limited/broken webRequest — detect availability
const hasWebRequest = typeof chrome.webRequest !== "undefined" &&
    typeof chrome.webRequest.onBeforeSendHeaders !== "undefined";

function networkStartCapture(filters, maxEntries) {
    if (!hasWebRequest) {
        return { capturing: false, error: "Network capture not available in this browser" };
    }

    networkCapture.active = true;
    networkCapture.filters = filters || [];
    networkCapture.requests = [];
    networkCapture.maxEntries = maxEntries || 1000;

    if (!networkStartCapture._listening) {
        chrome.webRequest.onBeforeSendHeaders.addListener(
            networkOnRequest,
            { urls: ["<all_urls>"] },
            ["requestHeaders", "extraHeaders"]
        );
        chrome.webRequest.onCompleted.addListener(
            networkOnResponse,
            { urls: ["<all_urls>"] },
            ["responseHeaders", "extraHeaders"]
        );
        // Capture request bodies for POST/PUT/PATCH
        chrome.webRequest.onBeforeRequest.addListener(
            networkOnRequestBody,
            { urls: ["<all_urls>"] },
            ["requestBody"]
        );
        networkStartCapture._listening = true;
    }

    return { capturing: true, filters: networkCapture.filters };
}

function networkStopCapture() {
    networkCapture.active = false;
    if (hasWebRequest && networkStartCapture._listening) {
        chrome.webRequest.onBeforeSendHeaders.removeListener(networkOnRequest);
        chrome.webRequest.onCompleted.removeListener(networkOnResponse);
        chrome.webRequest.onBeforeRequest.removeListener(networkOnRequestBody);
        networkStartCapture._listening = false;
    }
    return { stopped: true, captured: networkCapture.requests.length };
}

/**
 * List requests - LIGHTWEIGHT. Only returns method, url, status, type, id.
 * No headers, no bodies. Agent asks for those separately.
 */
function networkList(filter, limit, offset) {
    let entries = networkCapture.requests;

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(
            (e) => e.url.toLowerCase().includes(f) ||
                   e.method.toLowerCase().includes(f) ||
                   (e.type && e.type.toLowerCase().includes(f))
        );
    }

    const total = entries.length;
    const start = offset || 0;
    entries = entries.slice(start, start + (limit || 50));

    return {
        total,
        offset: start,
        count: entries.length,
        requests: entries.map((e) => ({
            id: e.id,
            method: e.method,
            url: e.url,
            status: e.status,
            type: e.type,
            timestamp: e.timestamp,
        })),
    };
}

/**
 * Get full details for a single request by ID.
 * Returns request headers, response headers, request body.
 */
function networkGetRequest(reqId) {
    const entry = networkCapture.requests.find((e) => e.id === reqId);
    if (!entry) return { error: "Request not found" };
    return {
        id: entry.id,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        type: entry.type,
        timestamp: entry.timestamp,
        requestHeaders: entry.requestHeaders,
        responseHeaders: entry.responseHeaders,
        requestBody: entry.requestBody || null,
    };
}

/**
 * Get details for multiple requests by IDs.
 */
function networkGetRequests(reqIds) {
    return reqIds.map((id) => {
        const entry = networkCapture.requests.find((e) => e.id === id);
        if (!entry) return { id, error: "not found" };
        return {
            id: entry.id,
            method: entry.method,
            url: entry.url,
            status: entry.status,
            requestHeaders: entry.requestHeaders,
            responseHeaders: entry.responseHeaders,
            requestBody: entry.requestBody || null,
        };
    });
}

/**
 * Get only headers for a request (no body).
 */
function networkGetHeaders(reqId) {
    const entry = networkCapture.requests.find((e) => e.id === reqId);
    if (!entry) return { error: "Request not found" };
    return {
        id: entry.id,
        url: entry.url,
        requestHeaders: entry.requestHeaders,
        responseHeaders: entry.responseHeaders,
    };
}

function networkClear() {
    networkCapture.requests = [];
    return { cleared: true };
}

function networkOnRequestBody(details) {
    if (!networkCapture.active) return;
    if (details.url.includes("127.0.0.1:7890")) return;
    if (networkCapture.filters.length > 0) {
        if (!networkCapture.filters.some((f) => details.url.includes(f))) return;
    }

    // Store body for later lookup
    const body = details.requestBody;
    if (!body) return;

    let bodyStr = null;
    if (body.raw && body.raw.length > 0) {
        // Raw bytes - decode
        const decoder = new TextDecoder();
        bodyStr = body.raw.map((r) => r.bytes ? decoder.decode(r.bytes) : "").join("");
    } else if (body.formData) {
        bodyStr = JSON.stringify(body.formData);
    }

    // Find or create the entry (onBeforeRequest fires before onBeforeSendHeaders)
    let entry = networkCapture.requests.find((e) => e.id === details.requestId);
    if (entry) {
        entry.requestBody = bodyStr;
    } else {
        // Create a placeholder, onBeforeSendHeaders will fill the rest
        networkCapture.requests.push({
            id: details.requestId,
            method: details.method,
            url: details.url,
            type: details.type,
            timestamp: Date.now(),
            requestHeaders: null,
            responseHeaders: null,
            status: null,
            requestBody: bodyStr,
        });
    }
}

function networkOnRequest(details) {
    if (!networkCapture.active) return;
    if (details.url.includes("127.0.0.1:7890")) return;
    if (networkCapture.filters.length > 0) {
        if (!networkCapture.filters.some((f) => details.url.includes(f))) return;
    }

    // Check if entry already exists (from onBeforeRequest body capture)
    let entry = networkCapture.requests.find((e) => e.id === details.requestId);
    if (entry) {
        entry.requestHeaders = headersToObj(details.requestHeaders);
        entry.method = details.method;
        entry.type = details.type;
    } else {
        networkCapture.requests.push({
            id: details.requestId,
            method: details.method,
            url: details.url,
            type: details.type,
            timestamp: Date.now(),
            requestHeaders: headersToObj(details.requestHeaders),
            responseHeaders: null,
            status: null,
            requestBody: null,
        });
    }

    if (networkCapture.requests.length > networkCapture.maxEntries) {
        networkCapture.requests = networkCapture.requests.slice(-networkCapture.maxEntries);
    }
}

function networkOnResponse(details) {
    if (!networkCapture.active) return;
    const entry = networkCapture.requests.find((e) => e.id === details.requestId);
    if (entry) {
        entry.status = details.statusCode;
        entry.responseHeaders = headersToObj(details.responseHeaders);
    }
}

function headersToObj(headers) {
    if (!headers) return {};
    const obj = {};
    for (const h of headers) {
        obj[h.name.toLowerCase()] = h.value;
    }
    return obj;
}

// ── Browser-context Fetch ────────────────────────────────────────────────────
// Executes fetch() inside the active tab's page context.
// This means the request carries the page's cookies, auth tokens, CORS origin,
// and session - so it won't get blocked by the server.

async function browserFetch(params) {
    // Use a Neo tab if available, fall back to finding a tab on the target domain
    let tabId = null;
    const targetDomain = new URL(params.url).hostname;

    // First try: Neo tab already on this domain
    for (const id of neoTabIds) {
        try {
            const t = await chrome.tabs.get(id);
            if (t && t.url && new URL(t.url).hostname === targetDomain) { tabId = t.id; break; }
        } catch {}
    }

    // Second try: any tab on this domain (read-only execution, doesn't navigate)
    if (!tabId) {
        const domainTabs = await chrome.tabs.query({ url: `*://${targetDomain}/*` });
        if (domainTabs.length > 0) tabId = domainTabs[0].id;
    }

    // Third try: navigate a Neo tab to the domain first
    if (!tabId) {
        const result = await neoNavigate(`https://${targetDomain}`);
        tabId = result.tab_id;
    }

    if (!tabId) throw new Error("Could not get a tab for " + targetDomain);

    const mergedHeaders = { ...(params.headers || {}) };

    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (url, options) => {
            try {
                const res = await fetch(url, {
                    method: options.method || "GET",
                    headers: options.headers || {},
                    body: options.body || undefined,
                    credentials: options.credentials || "include",
                    mode: options.mode || "cors",
                });

                const contentType = res.headers.get("content-type") || "";
                let body;
                if (contentType.includes("json")) {
                    body = await res.json();
                } else {
                    body = await res.text();
                    // Truncate huge responses
                    if (body.length > 100000) body = body.slice(0, 100000) + "\n...(truncated)";
                }

                const headers = {};
                res.headers.forEach((v, k) => { headers[k] = v; });

                return {
                    ok: res.ok,
                    status: res.status,
                    statusText: res.statusText,
                    headers,
                    body,
                };
            } catch (err) {
                return { error: err.message || String(err) };
            }
        },
        args: [params.url, {
            method: params.method,
            headers: mergedHeaders,
            body: params.body,
            credentials: params.credentials || "include",
            mode: params.mode,
        }],
    });

    const result = results[0]?.result;
    if (!result) throw new Error("Fetch execution failed");
    if (result.error) throw new Error(result.error);
    return result;
}

// ── MCP Server Relay (Cowork → localhost MCP HTTP server) ────────────────────
// Allows Cowork (via page-bridge → content.js → background.js) to call the
// same MCP tools that Claude Desktop gets via stdio. The extension can reach
// localhost while Cowork's sandboxed VM cannot.

async function mcpRequest(params) {
    const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    };
    if (mcpSessionId) {
        headers["mcp-session-id"] = mcpSessionId;
    }

    const response = await fetch(NEO_MCP_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(params.message),
    });

    // Capture session ID from response
    const sid = response.headers.get("mcp-session-id");
    if (sid) mcpSessionId = sid;

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        // If session expired/invalid (server restarted), clear it so next call re-initializes
        if (response.status === 400 && errText.includes("session")) {
            mcpSessionId = null;
        }
        throw new Error(`MCP server error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();

    // MCP Streamable HTTP returns SSE format: "event: message\ndata: {...}\n\n"
    // Parse the last JSON-RPC message from the SSE stream
    if (contentType.includes("text/event-stream") || text.startsWith("event:")) {
        const lines = text.split("\n");
        let lastData = null;
        for (const line of lines) {
            if (line.startsWith("data: ")) {
                try { lastData = JSON.parse(line.slice(6)); } catch {}
            }
        }
        return lastData || { error: "No valid SSE data in response" };
    }

    // Plain JSON response
    try { return JSON.parse(text); } catch { return { raw: text }; }
}

// High-level helpers for common MCP operations

async function mcpEnsureSession(forceNew) {
    if (mcpSessionId && !forceNew) return;
    mcpSessionId = null; // Clear stale session
    // Initialize MCP session
    await mcpRequest({
        message: {
            jsonrpc: "2.0",
            method: "initialize",
            params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "neo-bridge-relay", version: "1.0.0" },
            },
            id: "init_" + Date.now(),
        },
    });
    // Send initialized notification
    await mcpRequest({
        message: {
            jsonrpc: "2.0",
            method: "notifications/initialized",
        },
    });
}

// Wrapper that retries once on session errors (handles server restarts)
async function mcpWithRetry(fn) {
    try {
        await mcpEnsureSession();
        return await fn();
    } catch (e) {
        if (e.message && e.message.includes("session")) {
            // Session was invalidated — re-init and retry once
            await mcpEnsureSession(true);
            return await fn();
        }
        throw e;
    }
}

async function mcpToolsList() {
    return mcpWithRetry(async () => {
        const result = await mcpRequest({
            message: {
                jsonrpc: "2.0",
                method: "tools/list",
                params: {},
                id: "list_" + Date.now(),
            },
        });
        const tools = result?.result?.tools || [];
        return tools.map((t) => ({ name: t.name, description: t.description }));
    });
}

async function mcpToolCall(name, args) {
    return mcpWithRetry(async () => {
        const result = await mcpRequest({
            message: {
                jsonrpc: "2.0",
                method: "tools/call",
                params: { name, arguments: args },
                id: "call_" + Date.now(),
            },
        });
        if (result?.result?.content) {
            const texts = result.result.content
                .filter((c) => c.type === "text")
                .map((c) => c.text);
            try {
                return texts.length === 1 ? JSON.parse(texts[0]) : texts;
            } catch {
                return texts.length === 1 ? texts[0] : texts;
            }
        }
        return result;
    });
}

// ── Auto-detection: watch for logins ─────────────────────────────────────────

const AUTH_DOMAINS = {
    "slack.com": "slack",
    "discord.com": "discord",
    "linkedin.com": "linkedin",
    "x.com": "twitter",
    "twitter.com": "twitter",
    "github.com": "github",
    "notion.so": "notion",
    "mail.google.com": "gmail",
};

chrome.webNavigation.onCompleted.addListener(async (details) => {
    if (details.frameId !== 0) return; // only main frame

    // ── Inject page-bridge.js into MAIN world (bypasses page CSP) ────────
    // Manifest-declared MAIN world scripts get blocked by strict CSP on sites
    // like Google. chrome.scripting.executeScript is exempt from page CSP.
    try {
        if (!details.url.startsWith("chrome://") && !details.url.startsWith("chrome-extension://") && !details.url.startsWith("about:")) {
            await chrome.scripting.executeScript({
                target: { tabId: details.tabId },
                files: ["page-bridge.js"],
                world: "MAIN",
            });
        }
    } catch (e) {
        // Silently ignore — some special pages can't be injected
    }

    try {
        const url = new URL(details.url);
        const hostname = url.hostname.replace("www.", "");

        for (const [domain, service] of Object.entries(AUTH_DOMAINS)) {
            if (hostname.endsWith(domain)) {
                // Notify daemon that user is on a service page
                send({
                    event: "service_detected",
                    data: { service, url: details.url, tab_id: details.tabId },
                });
                break;
            }
        }
    } catch {}
});

// ── Message from popup ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "get_status") {
        sendResponse({ connected, wsUrl: NEO_WS_URL });
    } else if (msg.type === "reconnect") {
        connect();
        sendResponse({ ok: true });
    } else if (msg.type === "extract_auth") {
        extractAuth(msg.service).then(sendResponse);
        return true; // async
    } else if (msg.action === "relay_command") {
        // Cowork relay: content script forwards commands from window.postMessage
        // Inject the sender's tab ID so tab-targeting commands (read_page, click,
        // screenshot, etc.) operate on the tab the user is actually viewing,
        // instead of requiring a Neo-managed tab.
        const relayParams = Object.assign({}, msg.params || {});
        if (sender && sender.tab && sender.tab.id && !relayParams.tab_id) {
            relayParams.tab_id = sender.tab.id;
            relayParams._relay_tab_id = sender.tab.id; // marker for screenshot/execOnNeoTab
        }
        handleCommand(msg.method, relayParams)
            .then((result) => sendResponse(result))
            .catch((err) => sendResponse({ error: err.message || String(err) }));
        return true; // async
    }
});

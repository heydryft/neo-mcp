/**
 * Neo Bridge - Page World Helper
 *
 * Runs in the page's MAIN world (not the isolated content script world).
 * This means window.__neo_call is visible to any page JS, including
 * Claude in Chrome's javascript_tool.
 *
 * Communication: postMessage → content.js (isolated world) → background.js
 */

(function () {
    if (window.__neo_bridge_available) return;

    window.__neo_bridge_available = true;

    // ── Security: consume the per-page nonce planted by background.js ────
    // The nonce is set as a non-enumerable property just before this script
    // runs. We read it, delete it, and close over it so no page script can
    // access it after this point.
    var _nonce = window.__neo_pending_nonce || null;
    try { delete window.__neo_pending_nonce; } catch (e) {
        // In case delete fails (shouldn't with configurable:true), overwrite
        try {
            Object.defineProperty(window, '__neo_pending_nonce', {
                value: undefined, configurable: true, enumerable: false, writable: false,
            });
        } catch (e2) { /* best effort */ }
    }

    /**
     * Call a Neo Bridge command and get the result.
     * @param {string} method - Command name (e.g. "extract_auth", "browser_fetch")
     * @param {object} params - Command parameters
     * @returns {Promise<any>} - Command result
     */
    window.__neo_call = function (method, params) {
        return new Promise(function (resolve, reject) {
            if (!_nonce) {
                reject(new Error("Neo bridge not initialized (missing nonce)"));
                return;
            }
            var id = "neo_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
            var timeout = setTimeout(function () {
                window.removeEventListener("message", handler);
                reject(new Error("Neo command timed out after 30s"));
            }, 30000);

            function handler(event) {
                if (event.source !== window) return;
                if (!event.data || event.data.type !== "neo_response") return;
                if (event.data.id !== id) return;
                window.removeEventListener("message", handler);
                clearTimeout(timeout);
                var res = event.data.result;
                if (res && res.error) reject(new Error(res.error));
                else resolve(res);
            }

            window.addEventListener("message", handler);
            window.postMessage(
                { type: "neo_command", id: id, nonce: _nonce, method: method, params: params || {} },
                "*"
            );
        });
    };

    /**
     * Call multiple Neo Bridge commands in parallel.
     * @param {Array<{method: string, params?: object}>} calls
     * @returns {Promise<Array<any>>} - Array of results (or Error objects for failed calls)
     */
    window.__neo_batch = function (calls) {
        return Promise.all(
            calls.map(function (c) {
                return window.__neo_call(c.method, c.params || {}).catch(function (e) { return e; });
            })
        );
    };

    // ── MCP Server Tools (same tools as Claude Desktop) ─────────────────────
    // These relay through: page → content.js → background.js → localhost:3100/mcp
    // The MCP server must be running on the host: node dist/server.js

    /**
     * List all MCP tools available on the Neo MCP server.
     * @returns {Promise<Array<{name: string, description: string}>>}
     */
    window.__neo_mcp_tools = function () {
        return window.__neo_call("mcp_tools_list", {});
    };

    /**
     * Call an MCP tool by name — identical to what Claude Desktop can do.
     * @param {string} name - Tool name (e.g. "linkedin_post", "twitter_search")
     * @param {object} args - Tool arguments
     * @returns {Promise<any>} - Tool result (parsed JSON when possible)
     *
     * Examples:
     *   await __neo_mcp("twitter_profile", { screen_name: "elonmusk" })
     *   await __neo_mcp("linkedin_post", { text: "Hello from Cowork!" })
     *   await __neo_mcp("twitter_search", { query: "neo mcp", count: 10 })
     */
    window.__neo_mcp = function (name, args) {
        return window.__neo_call("mcp_tool_call", { name: name, arguments: args || {} });
    };

    /**
     * Send a raw MCP JSON-RPC message to the server.
     * @param {object} message - Full JSON-RPC message
     * @returns {Promise<any>} - Raw JSON-RPC response
     */
    window.__neo_mcp_raw = function (message) {
        return window.__neo_call("mcp_request", { message: message });
    };

    /**
     * List all available Neo Bridge commands (low-level extension commands).
     */
    window.__neo_commands = {
        auth: ["extract_auth", "extract_cookies", "set_cookie", "extract_local_storage", "extract_session_storage"],
        navigation: ["navigate", "get_url", "get_tabs", "new_tab", "close_tab", "close_all_tabs", "switch_tab", "navigate_tab", "go_back", "go_forward", "reload"],
        dom_interaction: ["click", "type", "press_key", "clear", "select", "check", "scroll", "focus", "hover", "drag_drop"],
        dom_reading: ["read_text", "read_html", "read_page", "scroll_collect", "read_attribute", "read_value", "query_selector", "query_selector_all", "wait_for", "wait_for_navigation", "get_page_info"],
        screenshots: ["screenshot", "screenshot_full"],
        network: ["network_start_capture", "network_stop_capture", "network_list", "network_get_request", "network_get_requests", "network_get_headers", "network_clear"],
        fetch: ["browser_fetch"],
        history: ["get_history"],
        js: ["execute_js"],
        mcp: ["mcp_request", "mcp_tools_list", "mcp_tool_call"],
        misc: ["get_profile", "download"]
    };
})();

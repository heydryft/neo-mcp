# Custom Tools

> *"Build me a Notion integration"* — Claude will reverse-engineer the API and create tools.

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `create_tool` | Create a new MCP tool that persists across restarts. You write the implementation as JavaScript.  Your code runs as an async function with these available:   params        - the tool's input (defined by params_schema)   helpers.credentials(service)   - get stored auth tokens for a service   helpers.browserFetch(url, opts) - HTTP request from browser (carries cookies)   helpers.store(service, key, val) - store a credential   helpers.query(collection, opts) - query a collection   helpers.insert(collection, data) - insert into collection   fetch         - standard fetch for direct HTTP calls  Example — creating a Notion integration:   name: "notion_get_pages"   description: "Get all pages from Notion workspace"   params_schema: { "limit": "number?" }   code: \|     const creds = helpers.credentials("notion");     if (!creds.token_v2) throw new Error("No Notion token. Run extract_auth('notion') first.");     const res = await fetch("https://www.notion.so/api/v3/getSpaces", {       method: "POST",       headers: { "Cookie": "token_v2=" + creds.token_v2, "Content-Type": "application/json" },       body: JSON.stringify({}),     });     return await res.json(); | `name`, `description`, `params_schema`, `code`, `service?` |
| `update_tool` | Update an existing custom tool's description, parameters, or code. | `name`, `description?`, `params_schema?`, `code?` |
| `list_custom_tools` | List all custom tools that have been created. | — |
| `get_tool_code` | View the implementation code of a custom tool. | `name` |
| `delete_tool` | Delete a custom tool. | `name` |
<!-- AUTO-GENERATED:END -->

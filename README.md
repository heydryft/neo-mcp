# Neo MCP

MCP server that gives Claude access to your real accounts — LinkedIn, Twitter/X, WhatsApp, and any website you're logged into. No API keys. No OAuth. It grabs auth tokens straight from your browser.

The AI can also build its own integrations at runtime for any service you use.

## Install

### 1. Add to Claude Desktop

Add to your Claude Desktop MCP config (`Settings > Developer > Edit Config`):

```json
{
  "mcpServers": {
    "neo": {
      "command": "npx",
      "args": ["-y", "github:heydryft/neo-mcp"]
    }
  }
}
```

Restart Claude Desktop. Done.

### 2. Install the Chrome extension

The extension is what lets Neo access your browser sessions.

1. `git clone https://github.com/heydryft/neo-mcp.git`
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select the `extension/` folder

The Neo Bridge icon appears in your toolbar. It auto-connects to the MCP server.

## What you can do

### Use your LinkedIn

Tell Claude: *"Extract my LinkedIn auth and get my recent posts with engagement metrics"*

| Tool | What it does |
|------|-------------|
| `linkedin_profile` | Get a user's profile |
| `linkedin_my_posts` | Your posts with likes, comments, reposts, impressions |
| `linkedin_feed` | Your feed |
| `linkedin_post` | Create a post |
| `linkedin_search` | Search for people |
| `linkedin_connections` | List your connections |

### Use your Twitter/X

Tell Claude: *"Extract my Twitter auth and show me my recent tweets"*

Bearer token and GraphQL query IDs are extracted automatically from Twitter's JS bundle at runtime — they rotate with every deployment, so they can't be hardcoded.

| Tool | What it does |
|------|-------------|
| `twitter_profile` | Get a user's profile |
| `twitter_user_tweets` | A user's tweets with engagement |
| `twitter_timeline` | Your home timeline |
| `twitter_post` | Post a tweet (or reply) |
| `twitter_search` | Search tweets |

### Use your WhatsApp

Tell Claude: *"Connect to WhatsApp"* → scan QR code → done forever.

| Tool | What it does |
|------|-------------|
| `whatsapp_connect` | Connect via QR code (first time) or auto-reconnect |
| `whatsapp_chats` | List chats with last message + unread count |
| `whatsapp_read` | Read messages by chat ID, phone number, or contact name |
| `whatsapp_send` | Send a message |

### Use ANY website you're logged into

These three tools work on any site — no pre-built integration needed:

| Tool | What it does |
|------|-------------|
| `extract_auth` | Grab auth tokens from any logged-in browser session (Slack, Discord, GitHub, Notion, Salesforce, anything) |
| `authenticated_fetch` | Make HTTP requests carrying the browser's cookies/auth |
| `discover_api` | Capture network traffic to find a site's API endpoints |

### Build new integrations on the fly

Tell Claude: *"Build me a Notion integration"* and it will:

1. `extract_auth("notion")` — grab your Notion token from Chrome
2. `discover_api(start, navigate: "notion.so")` — capture Notion's API traffic
3. `discover_api(list)` — see all the endpoints
4. `create_tool(...)` — write JavaScript implementations and register them as real MCP tools

Those tools are available immediately and persist across restarts.

| Tool | What it does |
|------|-------------|
| `create_tool` | Create a new MCP tool with JavaScript. Available immediately + persists. |
| `list_custom_tools` | List all tools the AI has created |
| `get_tool_code` | View a custom tool's source code |
| `delete_tool` | Delete a custom tool |

### Store structured data

The AI can create its own database tables to store anything it collects.

| Tool | What it does |
|------|-------------|
| `collection_create` | Create a table with custom schema + full-text search |
| `collection_insert` | Insert a row |
| `collection_query` | Query with FTS, filters, ordering, pagination |
| `collection_update` | Update a row by ID |
| `collection_delete` | Delete a row by ID |
| `collection_list` | List all collections |

## How it works

```
Claude Desktop ←→ Neo MCP Server (stdio) ←→ WebSocket Bridge ←→ Chrome Extension
                         ↓
                    SQLite DB (~/.neo-mcp/)
              (credentials, collections, custom tools)
```

1. The **Chrome extension** extracts auth tokens from your logged-in browser sessions and can make authenticated HTTP requests on your behalf
2. The **MCP server** uses those tokens to call service APIs directly (LinkedIn, Twitter) or proxies requests through the browser (authenticated_fetch)
3. **Custom tools** the AI creates are stored in SQLite and loaded on every startup
4. **WhatsApp** uses Baileys (multi-device protocol) — connects once via QR, persists session to disk

After initial token extraction, LinkedIn and Twitter work without the browser open. WhatsApp runs its own persistent connection.

## License

MIT

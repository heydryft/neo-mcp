# Neo MCP

MCP server that gives Claude (or any AI) access to LinkedIn, Twitter/X, WhatsApp, and any website you're logged into. The AI can also create its own integrations at runtime.

## What it does

- **LinkedIn** — Read your posts + engagement, read feed, create posts, search people, list connections
- **Twitter/X** — Read tweets + engagement, read timeline, post tweets, search
- **WhatsApp** — Send/read messages, list chats, contact lookup
- **Any website** — Extract auth tokens from your browser, make authenticated API calls as the logged-in user
- **Self-extending** — The AI can create new tools at runtime that persist across restarts. Tell it to "build me a Notion integration" and it will.

## Install

### 1. Add to Claude Desktop

Add this to your Claude Desktop MCP config:

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

That's it. Claude installs and runs it automatically.

### 2. Install the Chrome extension

1. Clone the repo (just for the extension folder): `git clone https://github.com/heydryft/neo-mcp.git`
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked**
5. Select the `extension/` folder

You'll see the Neo Bridge icon in your extensions bar. It connects automatically.

## Tools

### Auth & Fetch (work on any website)

| Tool | What it does |
|------|-------------|
| `extract_auth` | Grab auth tokens from any logged-in browser session (LinkedIn, Twitter, Slack, Discord, GitHub, Notion, or any domain) |
| `authenticated_fetch` | Make HTTP requests carrying the browser's cookies/auth. Works on any site you're logged into. |
| `discover_api` | Capture network traffic to find a site's API endpoints, then call them with `authenticated_fetch` |

### LinkedIn

| Tool | What it does |
|------|-------------|
| `linkedin_profile` | Get a user's profile by vanity name |
| `linkedin_my_posts` | Your posts with likes, comments, reposts, impressions |
| `linkedin_feed` | Your feed |
| `linkedin_post` | Create a post |
| `linkedin_search` | Search for people |
| `linkedin_connections` | List your connections |

**Setup:** Just tell Claude to `extract_auth("linkedin")` while you're logged into LinkedIn in Chrome. Done.

### Twitter/X

| Tool | What it does |
|------|-------------|
| `twitter_profile` | Get a user's profile |
| `twitter_user_tweets` | A user's tweets with engagement |
| `twitter_timeline` | Your home timeline |
| `twitter_post` | Post a tweet (or reply) |
| `twitter_search` | Search tweets |

**Setup:** `extract_auth("twitter")` while logged into X.com. Bearer token and GraphQL query IDs are extracted automatically from Twitter's JS bundle at runtime (they rotate with every deployment, so they can't be hardcoded).

### WhatsApp

| Tool | What it does |
|------|-------------|
| `whatsapp_connect` | Connect via QR code (first time) or auto-reconnect |
| `whatsapp_chats` | List chats with last message + unread count |
| `whatsapp_read` | Read messages by chat ID, phone number, or contact name |
| `whatsapp_send` | Send a message |

**Setup:** Tell Claude to `whatsapp_connect`. Scan the QR code with your phone. After that it auto-reconnects.

### Collections (structured data storage)

| Tool | What it does |
|------|-------------|
| `collection_create` | Create a table with custom schema + automatic full-text search |
| `collection_insert` | Insert a row |
| `collection_query` | Query with FTS, filters, ordering, pagination |
| `collection_update` | Update a row by ID |
| `collection_delete` | Delete a row by ID |
| `collection_list` | List all collections |

### Self-extending tools

| Tool | What it does |
|------|-------------|
| `create_tool` | Create a new MCP tool with JavaScript implementation. Available immediately + persists across restarts. |
| `list_custom_tools` | List all tools the AI has created |
| `get_tool_code` | View a custom tool's implementation |
| `delete_tool` | Delete a custom tool |

## How self-extending works

Tell Claude something like "build me a Notion integration" and it will:

1. `extract_auth("notion")` — grab your Notion token from Chrome
2. `discover_api(start, navigate: "notion.so")` — capture Notion's API traffic
3. `discover_api(list)` — see all the endpoints
4. `create_tool(...)` — write JavaScript implementations for each endpoint and register them as real MCP tools

Next time you restart, those tools load automatically from SQLite.

The AI writes the JavaScript, which runs with these helpers:
- `params` — tool input
- `helpers.credentials(service)` — get stored auth tokens
- `helpers.browserFetch(url, opts)` — HTTP request from browser context
- `helpers.store(service, key, val)` — store a credential
- `helpers.query(collection, opts)` — query a collection
- `helpers.insert(collection, data)` — insert into collection
- `fetch` — standard fetch

## Data storage

Everything is stored in `~/.neo-mcp/`:
- `neo-mcp.db` — SQLite database (credentials, collections, custom tools)
- `whatsapp-auth/` — WhatsApp session (persists across restarts)

## Architecture

```
Claude ←→ MCP Server (stdio) ←→ WebSocket Bridge ←→ Chrome Extension
                ↓
           SQLite DB
        (credentials, collections, custom tools)
```

The Chrome extension handles auth token extraction and authenticated fetch requests. The MCP server handles everything else (LinkedIn/Twitter API calls, WhatsApp, collections, tool creation).

For LinkedIn and Twitter, tokens are extracted once from the browser and then used for direct HTTP calls — the browser doesn't need to be open for subsequent API calls.

## License

MIT

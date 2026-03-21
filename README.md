# Neo MCP

Give Claude access to your real accounts — LinkedIn, Twitter/X, WhatsApp, and any website you're logged into. No API keys. No OAuth. Neo grabs auth tokens straight from your browser.

Claude can also build its own integrations at runtime for any service you use.

---

## Quick Start

There are two pieces to install: the **MCP server** (talks to Claude) and the **Chrome extension** (talks to your browser).

### Step 1: Install the Chrome Extension

This is required for both transport modes — it's how Neo accesses your browser sessions.

1. Clone the repo:
   ```bash
   git clone https://github.com/heydryft/neo-mcp.git
   cd neo-mcp
   ```
2. Open `chrome://extensions` in Chrome
3. Turn on **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `extension/` folder from the cloned repo

You'll see the **Neo Bridge** icon in your toolbar.

### Step 2: Choose your transport

Pick one based on how you use Claude:

| | HTTP Server (recommended) | Stdio |
|---|---|---|
| **Best for** | Cowork, Claude Code, multiple clients | Claude Desktop (simple setup) |
| **How it runs** | Long-running process on your machine | Claude Desktop manages the process |
| **Supports multiple clients** | Yes | No (one session at a time) |
| **Setup effort** | Run one command | Edit a JSON config |

---

## Option A: HTTP Server (recommended)

The HTTP server runs on your machine and exposes an MCP endpoint that any client can connect to.

### 1. Build and start the server

```bash
cd neo-mcp
npm install
npm run build
npm run start:http
```

The server starts at `http://localhost:3100/mcp`.

To use a different port:

```bash
NEO_HTTP_PORT=4000 npm run start:http
```

### 2. Connect your client

#### Claude Desktop

Go to `Settings > Developer > Edit Config` and add:

```json
{
  "mcpServers": {
    "neo": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

Restart Claude Desktop.

#### Claude Code

```bash
claude mcp add neo --transport http http://localhost:3100/mcp
```

#### Cowork

Cowork runs in a sandboxed Linux VM on your machine. The server must run on your **host machine** (not inside the VM) because it needs access to the Chrome extension and local database.

Add Neo as a remote MCP server in your Cowork config pointing to `http://localhost:3100/mcp`.

#### Any MCP client

Point it at `http://localhost:3100/mcp` — it speaks [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http).

---

## Option B: Stdio (Claude Desktop only)

Claude Desktop launches and manages the server process directly. No separate terminal needed.

Go to `Settings > Developer > Edit Config` and add:

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

> **Note:** Stdio mode only supports one client at a time. If you need to connect from Cowork, Claude Code, or multiple clients, use the HTTP server instead.

---

## What You Can Do

Once installed, tell Claude to extract your auth tokens, then start using your accounts.

### LinkedIn

> *"Extract my LinkedIn auth and get my recent posts with engagement metrics"*

| Tool | What it does |
|------|---|
| `linkedin_profile` | Get any user's profile |
| `linkedin_my_posts` | Your posts with likes, comments, reposts, impressions |
| `linkedin_feed` | Your feed |
| `linkedin_post` | Create a post |
| `linkedin_search` | Search for people |
| `linkedin_connections` | List your connections |

### Twitter/X

> *"Extract my Twitter auth and show me my recent tweets"*

Bearer tokens and GraphQL query IDs are extracted automatically from Twitter's JS bundle — they rotate on every deploy so they can't be hardcoded.

| Tool | What it does |
|------|---|
| `twitter_profile` | Get any user's profile |
| `twitter_user_tweets` | A user's tweets with engagement stats |
| `twitter_timeline` | Your home timeline |
| `twitter_post` | Post a tweet or reply |
| `twitter_search` | Search tweets |

### WhatsApp

> *"Connect to WhatsApp"* → scan the QR code → connected forever

| Tool | What it does |
|------|---|
| `whatsapp_connect` | Connect via QR code (first time) or auto-reconnect |
| `whatsapp_chats` | List chats with last message + unread count |
| `whatsapp_read` | Read messages by chat ID, phone number, or contact name |
| `whatsapp_send` | Send a message |

### Any Website You're Logged Into

No pre-built integration needed — these work on any site:

| Tool | What it does |
|------|---|
| `extract_auth` | Grab auth tokens from any logged-in session (Slack, Discord, GitHub, Notion, Salesforce, anything) |
| `authenticated_fetch` | Make HTTP requests carrying the browser's cookies/auth |
| `network_capture` | Start, stop, or clear network request capture in the browser |
| `network_requests` | List captured requests (ID, method, status, URL) |
| `network_request_detail` | Get full headers and body for a captured request |
| `bridge_status` | Check if the Chrome extension is connected |

### API Discovery Workflow

To reverse-engineer any site's API:

1. `network_capture(action: "start", navigate: "notion.so")` — start capturing traffic
2. Interact with the site (or ask Claude to navigate)
3. `network_requests()` — list all captured API calls
4. `network_request_detail(id)` — inspect headers, body, auth patterns
5. `network_capture(action: "stop")` — stop capturing

### Build New Integrations On The Fly

Tell Claude: *"Build me a Notion integration"* and it will:

1. `extract_auth("notion")` — grab your Notion token from Chrome
2. `network_capture(action: "start", navigate: "notion.so")` — capture Notion's API traffic
3. `network_requests()` — see all the endpoints
4. `create_tool(...)` — write a JavaScript tool and register it as a real MCP tool

Custom tools are available immediately and persist across restarts.

| Tool | What it does |
|------|---|
| `create_tool` | Create a new MCP tool with JavaScript |
| `update_tool` | Update an existing custom tool's description, params, or code |
| `list_custom_tools` | List all AI-created tools |
| `get_tool_code` | View a custom tool's source |
| `delete_tool` | Remove a custom tool |

### Structured Data Storage

Claude can create its own database tables to store anything it collects.

| Tool | What it does |
|------|---|
| `collection_create` | Create a table with custom schema + full-text search |
| `collection_insert` | Insert a row |
| `collection_query` | Query with FTS, filters, ordering, pagination |
| `collection_update` | Update a row by ID |
| `collection_delete` | Delete a row by ID |
| `collection_list` | List all collections |

### Analytics

Track and monitor engagement across LinkedIn and Twitter posts over time.

| Tool | What it does |
|------|---|
| `content_monitor` | Fetch analytics on your recent posts (engagement rates, top performers) |
| `track_post` | Add a post to ongoing monitoring |
| `analytics_report` | Summary report of all tracked posts' performance |

### Credential Management

| Tool | What it does |
|------|---|
| `list_credentials` | List all stored service credentials (keys only, not values) |
| `store_credential` | Manually store a credential for a service |
| `list_profiles` | List all stored profiles for a service |

### Multi-Profile Support

Use multiple accounts for the same service:

> *"Extract my LinkedIn auth as 'business'"*
> *"Extract my LinkedIn auth as 'personal'"*
> *"Get my posts using the business profile"*

Credentials are stored per profile — switch between them by name.

---

## Architecture

```
Claude (Desktop / Code / Cowork)
          │
     stdio or HTTP
          │
    Neo MCP Server ──── SQLite DB (~/.neo-mcp/)
          │              (credentials, collections, custom tools)
     WebSocket
          │
    Chrome Extension ── Your Browser Sessions
                        (LinkedIn, Twitter, Slack, etc.)
```

1. The **Chrome extension** extracts auth tokens from your logged-in browser sessions and makes authenticated requests on your behalf
2. The **MCP server** uses those tokens to call service APIs (LinkedIn, Twitter) or proxies requests through the browser
3. **Custom tools** are stored in SQLite and reloaded on every startup
4. **WhatsApp** uses Baileys (multi-device protocol) — connects once via QR, then persists

After initial token extraction, LinkedIn and Twitter work without the browser open. WhatsApp maintains its own persistent connection.

---

## Troubleshooting

**Extension not connecting?**
The extension connects to the MCP server via WebSocket on `localhost:7890`. Make sure the server is running and no firewall is blocking local connections.

**`npm run build` fails?**
`better-sqlite3` requires native compilation. Make sure you have build tools installed:
- macOS: `xcode-select --install`
- Windows: `npm install -g windows-build-tools`
- Linux: `sudo apt install build-essential python3`

**Tokens not extracting?**
Make sure you're logged into the service in Chrome, then ask Claude to `extract_auth("service_name")`. The extension needs to be loaded and active.

## License

MIT

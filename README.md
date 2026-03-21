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
npm run mcp
```

The server starts at `http://localhost:3100/mcp`.

To use a different port:

```bash
NEO_HTTP_PORT=4000 npm run mcp
```

### 2. Connect your client

#### Claude Desktop

Go to `Settings > Developer > Edit Config` and add:

```json
{
  "mcpServers": {
    "neo": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3100/mcp"]
    }
  }
}
```

Restart Claude Desktop.

> **Note:** Claude Desktop doesn't natively support HTTP transport in its config file, so this uses [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) as a stdio-to-HTTP bridge.

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

## Option B: Stdio (deprecated)

> **Deprecated:** Stdio mode only supports one client at a time and lacks features like the WhatsApp QR flow. Use the HTTP server (Option A) instead.

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

### Slack

> *"Extract my Slack auth and show me unread messages"*

| Tool | What it does |
|------|---|
| `slack_channels` | List channels |
| `slack_read` | Read channel messages with pagination |
| `slack_thread` | Read a thread |
| `slack_dms` | Read DMs |
| `slack_search` | Search messages |
| `slack_send` | Send a message (with thread reply) |
| `slack_react` / `slack_unreact` | Add/remove reactions |
| `slack_edit` / `slack_delete` | Edit or delete messages |
| `slack_users` / `slack_user_profile` | List users, view profiles |
| `slack_set_status` | Set your status |
| `slack_create_channel` / `slack_archive_channel` | Manage channels |
| `slack_invite` / `slack_kick` | Manage channel members |
| `slack_pin` / `slack_unpin` / `slack_pins` | Pin management |
| `slack_set_topic` / `slack_set_purpose` | Set channel topic/purpose |

### Gmail

> *"Connect my Gmail"* → OAuth sign-in → connected

Gmail uses OAuth 2.0. Requires Google OAuth credentials — see [Gmail OAuth Setup](#gmail-oauth-setup) below. Supports multiple accounts via the `profile` parameter (e.g. `gmail_connect(profile: "work")`).

| Tool | What it does |
|------|---|
| `gmail_connect` | OAuth sign-in (opens browser) |
| `gmail_profile` | Account info |
| `gmail_inbox` | Read inbox with optional search filter |
| `gmail_search` | Full Gmail search (same syntax as Gmail search bar) |
| `gmail_read` | Read a specific message |
| `gmail_thread` | Read an entire thread |
| `gmail_send` | Send an email (with cc, bcc, thread reply) |
| `gmail_reply` | Reply to the last message in a thread |
| `gmail_draft` | Create a draft |
| `gmail_mark_read` / `gmail_archive` / `gmail_trash` / `gmail_star` | Message actions |
| `gmail_labels` / `gmail_label_create` / `gmail_modify` | Label management |

### WhatsApp

> *"Connect to WhatsApp"* → scan the QR code → connected forever

| Tool | What it does |
|------|---|
| `whatsapp_connect` | Connect via QR code (first time) or auto-reconnect |
| `whatsapp_chats` / `whatsapp_search_chats` | List or search chats |
| `whatsapp_read` | Read messages with pagination, search, and timestamp cursor |
| `whatsapp_search` | Search messages across all chats |
| `whatsapp_send` / `whatsapp_send_media` / `whatsapp_send_location` / `whatsapp_send_contact` | Send text, media, location, contacts |
| `whatsapp_check_number` / `whatsapp_find_contact` / `whatsapp_add_contact` | Contact management |
| `whatsapp_profile_pic` / `whatsapp_status` / `whatsapp_update_status` | Profile info |
| `whatsapp_presence` | Typing indicators, online status |
| `whatsapp_chat_modify` / `whatsapp_star` / `whatsapp_mark_read` | Chat actions |
| `whatsapp_block` / `whatsapp_unblock` / `whatsapp_blocklist` | Privacy |
| `whatsapp_group_*` | Full group management (create, members, invite, settings) |
| `whatsapp_newsletter_*` | WhatsApp channels |
| `whatsapp_business_profile` / `whatsapp_catalog` | Business features |

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

---

## Gmail OAuth Setup

Gmail requires Google OAuth credentials (one-time setup):

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project and enable the **Gmail API**
3. Go to **OAuth consent screen** → External → add app name
4. Go to **Credentials** → Create **OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3100/gmail/callback`
5. Set environment variables before starting Neo:

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com \
GOOGLE_CLIENT_SECRET=your-secret \
npm run mcp
```

You may see a "This app isn't verified" warning from Google — click **Advanced → Go to app (unsafe)** to proceed. This is normal for personal OAuth apps.

## License

MIT

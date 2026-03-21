<img width="2752" height="1536" alt="image" src="https://github.com/user-attachments/assets/9d1d575a-c1d7-4aae-94f4-0e480f4b1d31" />

# Neo MCP

<!-- TOOL_STATS -->

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

## Integrations

Once installed, tell Claude to extract your auth tokens, then start using your accounts.

<!-- INTEGRATIONS:START -->
<!-- INTEGRATIONS:END -->

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

Neo ships default OAuth credentials so `gmail_connect` works out of the box. You may see a "This app isn't verified" warning — click **Advanced → Go to app (unsafe)** to proceed.

To use your own credentials instead:

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

This bypasses the "unverified app" warning since the credentials are yours.

## License

MIT

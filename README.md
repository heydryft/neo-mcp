<img width="2752" height="1536" alt="image" src="https://github.com/user-attachments/assets/9d1d575a-c1d7-4aae-94f4-0e480f4b1d31" />

# Neo MCP

**206+ tools** across **16 integrations** — LinkedIn, Twitter/X, Slack, Gmail, WhatsApp, Google Calendar, Google Drive, Notion, Discord, GitHub, and more.

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

### LinkedIn

> *"Extract my LinkedIn auth and get my recent posts with engagement metrics"*

| Tool | What it does |
|------|---|
| `linkedin_profile` | Get a LinkedIn user's profile. Pass the vanity name (URL slug, e.g. 'nirupambhowmick'). |
| `linkedin_my_posts` | Get your own LinkedIn posts with engagement metrics (likes, comments, reposts, impressions). |
| `linkedin_profile_posts` | Get a LinkedIn user's posts by their vanity name (URL slug). |
| `linkedin_feed` | Get your LinkedIn feed. |
| `linkedin_post` | Create a LinkedIn post. |
| `linkedin_search` | Search for people on LinkedIn. |
| `linkedin_connections` | List your LinkedIn connections. |
| `linkedin_conversations` | List your recent LinkedIn message conversations. |
| `linkedin_messages` | Get messages in a specific LinkedIn conversation. Pass the conversationId from linkedin_conversations. |
| `linkedin_send_message` | Send a LinkedIn message to a connection. Pass their profile URN or vanity name (URL slug). |
| `linkedin_react` | React to a LinkedIn post (like, celebrate, support, love, insightful, funny). |
| `linkedin_comment` | Comment on a LinkedIn post. |
| `linkedin_post_comments` | Get comments on a LinkedIn post. |
| `linkedin_notifications` | Get your recent LinkedIn notifications. |
| `linkedin_send_connection` | Send a connection request to a LinkedIn user. |
| `linkedin_invitations` | Get your pending connection requests (received). |
| `linkedin_respond_invitation` | Accept or decline a pending connection request. |

[Full documentation with parameters →](docs/linkedin.md)

### Twitter/X

> *"Extract my Twitter auth and show me my recent tweets"*

Bearer tokens and GraphQL query IDs are extracted automatically from Twitter's JS bundle — they rotate on every deploy so they can't be hardcoded.

| Tool | What it does |
|------|---|
| `twitter_profile` | Get a Twitter/X user's profile. |
| `twitter_user_tweets` | Get a user's tweets with engagement metrics. |
| `twitter_timeline` | Get your home timeline. |
| `twitter_post` | Post a tweet. Optionally reply to another tweet. |
| `twitter_search` | Search tweets. |

[Full documentation with parameters →](docs/twitter.md)

### Slack

> *"Extract my Slack auth and show me unread messages"*

| Tool | What it does |
|------|---|
| `slack_channels` | List Slack channels. |
| `slack_channel_info` | Get details about a Slack channel. |
| `slack_read` | Read messages from a Slack channel. |
| `slack_thread` | Read a Slack thread. |
| `slack_dms` | Read recent DMs. |
| `slack_search` | Search Slack messages. |
| `slack_send` | Send a message to a Slack channel or DM. |
| `slack_react` | Add a reaction emoji to a message. |
| `slack_unreact` | Remove a reaction from a message. |
| `slack_edit` | Edit a Slack message. |
| `slack_delete` | Delete a Slack message. |
| `slack_users` | List Slack workspace users. |
| `slack_user_profile` | Get a Slack user's profile. |
| `slack_set_status` | Set your Slack status. |
| `slack_create_channel` | Create a Slack channel. |
| `slack_archive_channel` | Archive a Slack channel. |
| `slack_invite` | Invite users to a channel. |
| `slack_kick` | Remove a user from a channel. |
| `slack_set_topic` | Set a channel's topic. |
| `slack_set_purpose` | Set a channel's purpose. |
| `slack_pin` | Pin a message. |
| `slack_unpin` | Unpin a message. |
| `slack_pins` | List pinned messages in a channel. |

[Full documentation with parameters →](docs/slack.md)

### Gmail

> *"Connect my Gmail"* → OAuth sign-in → connected

Gmail uses OAuth 2.0. Default credentials are included — just call `gmail_connect` and sign in. See [Gmail OAuth Setup](../README.md#gmail-oauth-setup) for custom credentials.

| Tool | What it does |
|------|---|
| `gmail_connect` | Connect a Gmail account via OAuth. Opens Google sign-in in the browser. Use profile to connect multiple accounts. |
| `gmail_profile` | Get Gmail profile info (email, message count). |
| `gmail_inbox` | Read your Gmail inbox. |
| `gmail_search` | Search Gmail messages. |
| `gmail_read` | Read a specific email message. |
| `gmail_thread` | Read an entire email thread. |
| `gmail_send` | Send an email. |
| `gmail_reply` | Reply to the last message in a thread. |
| `gmail_draft` | Create a draft email. |
| `gmail_mark_read` | Mark an email as read. |
| `gmail_archive` | Archive an email (remove from inbox). |
| `gmail_trash` | Move an email to trash. |
| `gmail_star` | Star an email. |
| `gmail_labels` | List all Gmail labels. |
| `gmail_label_create` | Create a Gmail label. |
| `gmail_modify` | Add or remove labels from a message. |

[Full documentation with parameters →](docs/gmail.md)

### WhatsApp

> *"Connect to WhatsApp"* → scan the QR code → connected forever

| Tool | What it does |
|------|---|
| `whatsapp_connect` | Connect to WhatsApp. Opens a QR code in the browser on first use. Auto-reconnects after that. |
| `whatsapp_chats` | List WhatsApp chats with last message and unread count. |
| `whatsapp_search_chats` | Search WhatsApp chats by name. |
| `whatsapp_read` | Read messages from a WhatsApp chat with pagination and search. |
| `whatsapp_search` | Search messages across all WhatsApp chats by text content. |
| `whatsapp_send` | Send a WhatsApp text message. |
| `whatsapp_send_media` | Send media (image, video, document, audio, sticker) on WhatsApp. |
| `whatsapp_send_location` | Send a location on WhatsApp. |
| `whatsapp_send_contact` | Send a contact card on WhatsApp. |
| `whatsapp_check_number` | Check if a phone number is on WhatsApp. |
| `whatsapp_find_contact` | Search contacts by name or phone number. |
| `whatsapp_profile_pic` | Get profile picture URL for a contact or group. |
| `whatsapp_status` | Get a contact's status/bio. |
| `whatsapp_update_status` | Update your WhatsApp status/bio. |
| `whatsapp_presence` | Send presence update (typing indicator, online, etc.). |
| `whatsapp_add_contact` | Create or update a contact. |
| `whatsapp_chat_modify` | Archive, unarchive, mute, unmute, pin, or unpin a chat. |
| `whatsapp_star` | Star or unstar messages. |
| `whatsapp_mark_read` | Mark a chat as read. |
| `whatsapp_block` | Block a contact. |
| `whatsapp_unblock` | Unblock a contact. |
| `whatsapp_blocklist` | List all blocked contacts. |
| `whatsapp_group_info` | Get group metadata (members, description, settings). |
| `whatsapp_group_create` | Create a new WhatsApp group. |
| `whatsapp_group_participants` | Add, remove, promote, or demote group members. |
| `whatsapp_group_update_name` | Change a group's name. |
| `whatsapp_group_update_description` | Change a group's description. |
| `whatsapp_groups_list` | List all groups you're participating in. |
| `whatsapp_group_invite` | Get the invite link for a group. |
| `whatsapp_group_leave` | Leave a WhatsApp group. |
| `whatsapp_newsletter_create` | Create a new WhatsApp channel. |
| `whatsapp_newsletter_follow` | Follow a WhatsApp channel. |
| `whatsapp_newsletter_unfollow` | Unfollow a WhatsApp channel. |
| `whatsapp_newsletter_messages` | Get messages from a WhatsApp channel. |
| `whatsapp_newsletter_info` | Get info about a WhatsApp channel. |
| `whatsapp_business_profile` | Get a business profile. |
| `whatsapp_catalog` | Get a business's product catalog. |

[Full documentation with parameters →](docs/whatsapp.md)

### Google Calendar

> *"Connect my Google Calendar"*

| Tool | What it does |
|------|---|
| `gcal_connect` | Connect a Google Calendar account via OAuth. Opens Google sign-in in the browser. |
| `gcal_calendars` | List your Google Calendar calendars. |
| `gcal_events` | List upcoming calendar events. |
| `gcal_event` | Get a specific calendar event. |
| `gcal_create_event` | Create a calendar event. |
| `gcal_update_event` | Update a calendar event. |
| `gcal_delete_event` | Delete a calendar event. |
| `gcal_respond` | Respond to a calendar invite (accept/decline/tentative). |
| `gcal_quick_add` | Create an event from natural language text (e.g. 'Lunch with John tomorrow at noon'). |
| `gcal_freebusy` | Check free/busy status for calendars. |

[Full documentation with parameters →](docs/google-calendar.md)

### Google Drive

> *"Connect my Google Drive and list my files"*

| Tool | What it does |
|------|---|
| `gdrive_connect` | Connect a Google Drive account via OAuth. |
| `gdrive_files` | List files in Google Drive. |
| `gdrive_file` | Get file metadata. |
| `gdrive_search` | Search files by name. |
| `gdrive_read` | Read file content (Google Docs→text, Sheets→CSV, others→download). |
| `gdrive_create` | Create a file in Google Drive. |
| `gdrive_update` | Update a file's content. |
| `gdrive_delete` | Move a file to trash. |
| `gdrive_create_folder` | Create a folder. |
| `gdrive_shared_drives` | List shared drives. |
| `gdrive_quota` | Get storage quota. |

[Full documentation with parameters →](docs/google-drive.md)

### Notion

> *"Extract my Notion auth and list my pages"*

| Tool | What it does |
|------|---|
| `notion_spaces` | List your Notion workspaces. |
| `notion_search` | Search Notion pages and databases. |
| `notion_page` | Get a Notion page with its child blocks. |
| `notion_page_content` | Get a Notion page's content as readable markdown text. |
| `notion_block` | Get a specific Notion block. |
| `notion_create_page` | Create a new Notion page. |
| `notion_append` | Append a block to a Notion page. |
| `notion_update_block` | Update the text of a Notion block. |
| `notion_delete_block` | Delete a Notion block. |
| `notion_database` | Query a Notion database (collection). |
| `notion_recent` | Get your recently visited Notion pages. |

[Full documentation with parameters →](docs/notion.md)

### Discord

> *"Extract my Discord auth"*

| Tool | What it does |
|------|---|
| `discord_me` | Get your Discord profile. |
| `discord_guilds` | List your Discord servers. |
| `discord_guild` | Get Discord server details. |
| `discord_channels` | List channels in a Discord server. |
| `discord_messages` | Read messages from a Discord channel. |
| `discord_send` | Send a message to a Discord channel. |
| `discord_channel` | Get Discord channel info. |
| `discord_search` | Search messages in a Discord server. |
| `discord_dms` | List your Discord DM channels. |
| `discord_read_dm` | Read DM messages. |
| `discord_send_dm` | Send a DM to a user. |
| `discord_react` | Add a reaction to a message. |
| `discord_unreact` | Remove a reaction from a message. |
| `discord_members` | List members of a Discord server. |
| `discord_user` | Get a Discord user's profile. |

[Full documentation with parameters →](docs/discord.md)

### GitHub

> *"Extract my GitHub auth"*

| Tool | What it does |
|------|---|
| `github_me` | Get your authenticated GitHub profile. |
| `github_user` | Get a GitHub user's profile. |
| `github_repos` | List your GitHub repos. |
| `github_repo` | Get details about a GitHub repo. |
| `github_search_repos` | Search GitHub repositories. |
| `github_issues` | List issues for a repo. |
| `github_issue` | Get a specific issue. |
| `github_create_issue` | Create a GitHub issue. |
| `github_comment_issue` | Comment on a GitHub issue or PR. |
| `github_prs` | List pull requests for a repo. |
| `github_pr` | Get details about a pull request. |
| `github_pr_files` | Get files changed in a pull request. |
| `github_create_pr` | Create a pull request. |
| `github_merge_pr` | Merge a pull request. |
| `github_pr_reviews` | Get reviews on a pull request. |
| `github_review_pr` | Submit a review on a pull request. |
| `github_notifications` | Get your GitHub notifications. |
| `github_mark_notification_read` | Mark a notification as read. |
| `github_search_code` | Search code on GitHub. |
| `github_search_users` | Search GitHub users. |
| `github_starred` | List your starred repos. |
| `github_star` | Star a repo. |
| `github_unstar` | Unstar a repo. |
| `github_gists` | List your gists. |
| `github_create_gist` | Create a gist. |
| `github_actions` | List recent workflow runs for a repo. |
| `github_action_run` | Get details about a workflow run. |
| `github_rerun_workflow` | Re-run a failed workflow. |
| `github_file` | Get file or directory contents from a repo. |

[Full documentation with parameters →](docs/github.md)

### Browser & API Discovery

> No pre-built integration needed — these work on any site you're logged into.

| Tool | What it does |
|------|---|
| `extract_auth` | Extract auth tokens from the user's logged-in browser session. Supports: slack, discord, linkedin, twitter, github, notion, or any domain. Tokens are stored automatically for future API calls. Use the profile parameter to store credentials under a named profile (e.g. profile='business' stores as 'linkedin:business'). |
| `authenticated_fetch` | Make an HTTP request from the browser's context, carrying the page's cookies, auth, and session. Works on ANY website the user is logged into.  This is the meta-tool for building integrations on the fly. If no pre-built tool exists for a service: 1. Use discover_api to find the site's API endpoints 2. Use authenticated_fetch to call them 3. Use collection_create to save the discovered API pattern (endpoint, method, headers) so you can reuse it next time without rediscovering |
| `network_capture` | Start/stop/clear network request capture in the browser. Use network_requests to list and network_request_detail to inspect. |
| `network_requests` | List captured network requests. Returns id, method, status, URL. Use network_request_detail to get full headers/body for a specific request. |
| `network_request_detail` | Get full details for a captured request — request headers, response headers, and body. Pass the id from network_requests. |
| `bridge_status` | Check if the Neo Browser Bridge extension is connected. |
| `web_scrape` | Extract structured data from any URL. Returns clean, parsed content instead of raw HTML. Extracts: page title, meta description, main text content, all links, tables (as arrays), images, OpenGraph/meta tags, and JSON-LD structured data. Use this instead of authenticated_fetch when you need usable data from a page. |
| `diff_monitor` | Monitor any URL or API endpoint for changes. Stores snapshots in a collection, compares against the previous snapshot, and reports what changed. Use for: price tracking, job posting changes, competitor monitoring, stock availability, or any "tell me when X changes" request. |

[Full documentation with parameters →](docs/browser.md)

### Custom Tools

> *"Build me a Notion integration"* — Claude will reverse-engineer the API and create tools.

| Tool | What it does |
|------|---|
| `create_tool` | Create a new MCP tool that persists across restarts. You write the implementation as JavaScript.  Your code runs as an async function with these available:   params        - the tool's input (defined by params_schema)   helpers.credentials(service)   - get stored auth tokens for a service   helpers.browserFetch(url, opts) - HTTP request from browser (carries cookies)   helpers.store(service, key, val) - store a credential   helpers.query(collection, opts) - query a collection   helpers.insert(collection, data) - insert into collection   fetch         - standard fetch for direct HTTP calls  Example — creating a Notion integration:   name: "notion_get_pages"   description: "Get all pages from Notion workspace"   params_schema: { "limit": "number?" }   code: \|     const creds = helpers.credentials("notion");     if (!creds.token_v2) throw new Error("No Notion token. Run extract_auth('notion') first.");     const res = await fetch("https://www.notion.so/api/v3/getSpaces", {       method: "POST",       headers: { "Cookie": "token_v2=" + creds.token_v2, "Content-Type": "application/json" },       body: JSON.stringify({}),     });     return await res.json(); |
| `update_tool` | Update an existing custom tool's description, parameters, or code. |
| `list_custom_tools` | List all custom tools that have been created. |
| `get_tool_code` | View the implementation code of a custom tool. |
| `delete_tool` | Delete a custom tool. |

[Full documentation with parameters →](docs/custom-tools.md)

### Structured Data Storage

> Claude can create its own database tables to store anything it collects.

| Tool | What it does |
|------|---|
| `collection_create` | Create a new data collection (SQLite table with FTS). Design your own schema — columns with types (text, number, boolean, date, json). Use this to store structured data you've gathered. |
| `collection_insert` | Insert a row into a collection. |
| `collection_query` | Query a collection. Supports full-text search, where filters, ordering, and pagination. |
| `collection_list` | List all collections with their schemas. |
| `collection_update` | Update a row in a collection by ID. |
| `collection_delete` | Delete a row from a collection by ID. |

[Full documentation with parameters →](docs/collections.md)

### Analytics

> Track and monitor engagement across LinkedIn and Twitter posts over time.

| Tool | What it does |
|------|---|
| `content_monitor` | Fetch analytics on your recent posts for a service (linkedin or twitter). Returns engagement rates, best performing posts, and totals. For Twitter, pass your screen_name (handle) to fetch your own tweets. |
| `track_post` | Add a post to the analytics tracking collection for ongoing monitoring. Stores current engagement metrics in the neo_analytics collection. |
| `analytics_report` | Generate a summary report of all tracked posts' performance. Shows engagement totals, averages, and top performers. Uses the neo_analytics collection. |

[Full documentation with parameters →](docs/analytics.md)

### Credential Management

> Manage stored auth tokens and service profiles.

| Tool | What it does |
|------|---|
| `list_credentials` | List all stored service credentials (keys only, not values). |
| `store_credential` | Manually store a credential for a service. |
| `list_profiles` | List all stored profiles for a service. Profiles are named credential sets (e.g. linkedin:personal, linkedin:business). The default profile has no suffix. |

[Full documentation with parameters →](docs/credentials.md)

### Workflows

> Pre-built multi-step workflows that combine tools.

| Tool | What it does |
|------|---|
| `repurpose_content` | Repurpose content between social media platforms (LinkedIn ↔ Twitter). Analyzes the input text and transforms it to match the target platform's conventions, character limits, formatting style, and audience expectations. Returns ready-to-post content. |
| `meeting_prep` | Prepare for a meeting by pulling LinkedIn profiles of all attendees from a Google Calendar event. Returns attendee names, roles, companies, headlines, and profile URLs so you're fully briefed before any call. |
| `smart_inbox` | Unified notification inbox across all connected platforms. Returns a single view of what needs your attention: GitHub PRs/issues, LinkedIn messages, Slack DMs, Gmail unreads, and upcoming calendar events. |
| `contact_enrich` | Enrich a contact by searching across LinkedIn, Twitter, GitHub, and Notion. Given a name or email, returns all matching profiles with roles, bios, and links. |
| `content_calendar` | Manage a cross-platform content calendar. Store draft posts, schedule them via Google Calendar, and track what's been published. Uses a 'content_calendar' collection to persist drafts. |
| `pr_digest` | Get a digest of your GitHub activity: open PRs needing review, your PRs with pending reviews, failing CI, and recent issues. Optionally post a summary to a Slack channel. |
| `discover_api` | Discover a website's internal API by navigating to it and capturing network requests. This automates the API discovery workflow: 1. Extracts auth tokens from the target site 2. Starts network capture and navigates to the specified URL 3. Waits for API requests to load 4. Returns all captured API endpoints with their methods, URLs, status codes, and headers 5. Suggests which endpoints are useful and how to call them  Use this as the first step when building a new integration for ANY website. |

[Full documentation with parameters →](docs/workflows.md)

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

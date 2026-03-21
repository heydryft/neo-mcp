#!/usr/bin/env node
/**
 * Neo MCP Server
 *
 * Exposes Neo's integrations as MCP tools:
 * - Auth extraction (6 services + generic)
 * - LinkedIn, Twitter/X, Twitter/X (cookie-based API access)
 * - WhatsApp (Baileys multi-device)
 * - Collections (agent-designed SQLite tables)
 * - Authenticated fetch (make requests as logged-in user on ANY site)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import { randomUUID } from "node:crypto";
import * as linkedin from "./integrations/linkedin.js";
import * as twitter from "./integrations/twitter.js";
import * as slack from "./integrations/slack.js";
import * as gmail from "./integrations/gmail.js";
import * as github from "./integrations/github.js";
import * as gcal from "./integrations/gcal.js";
import * as notion from "./integrations/notion.js";
import * as discord from "./integrations/discord.js";
import * as gdrive from "./integrations/gdrive.js";
import * as db from "./db.js";
import { browserCommand, startBridge, isBridgeConnected } from "./bridge.js";

const NEO_INSTRUCTIONS = `Neo gives you direct API access to the user's real accounts — 10x-100x faster than browser automation. No API keys needed. You can operate ANY service the user is logged into.

## How to handle ANY request

STEP 1: Does a built-in tool exist?
Check the tool list. Tools are prefixed by service: linkedin_*, twitter_*, github_*, notion_*, discord_*, slack_*, gcal_*, gdrive_*, gmail_*, whatsapp_*. Also: meeting_prep, smart_inbox, contact_enrich, content_calendar, pr_digest, repurpose_content, discover_api, web_scrape, diff_monitor.
→ If yes: call it directly. Chain multiple tools for complex requests.
→ If no: go to Step 2.

STEP 2: Can you compose it from existing tools?
Most requests are just chains: "summarize my LinkedIn messages" = linkedin_conversations → linkedin_messages → your reasoning.
"Prep for my 2pm meeting" = gcal_events → meeting_prep or manually linkedin_profile each attendee.
"What needs my attention?" = smart_inbox (or chain github_notifications + linkedin_conversations + gcal_events yourself).
→ Think about what data you need, which tools provide it, and chain them. No new tool needed.

STEP 3: The service isn't built-in — reverse-engineer it.
Use discover_api(url) to auto-extract auth + capture API endpoints from ANY website. Or manually:
1. extract_auth("domain.com") — grab tokens/cookies from the browser
2. network_capture(start) + navigate — capture the site's API calls
3. network_request_detail(id) — inspect headers (CSRF tokens, auth headers, content-type)
4. authenticated_fetch(url, headers) — replay the request
5. create_tool(...) — save it permanently so you never repeat discovery

## Speed principles
- ALWAYS prefer neo tools over browser automation. API calls are instant; clicking through pages is slow.
- Chain tools in parallel when possible (e.g., fetch GitHub + LinkedIn + Calendar simultaneously).
- For cross-platform tasks, fetch all data first, then reason about it — don't alternate between fetching and thinking.
- web_scrape returns structured data from any URL — use it instead of authenticated_fetch when you need parsed content, not raw HTML.

## Service connection cheat sheet
| Service | Setup | Auth method |
|---------|-------|-------------|
| LinkedIn | extract_auth("linkedin") | Cookie-based (li_at) |
| Twitter/X | extract_auth("twitter") | Cookie-based (auth_token) |
| GitHub | Auto-detects gh CLI, or store_credential("github","token","ghp_...") | PAT token |
| Notion | extract_auth("notion") | Cookie-based (token_v2) |
| Discord | extract_auth("discord") | Token-based |
| Slack | extract_auth("slack") | Cookie-based (xoxc) |
| Google Calendar | gcal_connect | OAuth |
| Google Drive | gdrive_connect | OAuth |
| Gmail | gmail_connect | OAuth |
| WhatsApp | whatsapp_connect | QR code |
| Any other site | extract_auth("domain") + discover_api | Cookie/token |

## create_tool — make permanent tools on the fly
Creates a real MCP tool, available immediately (no restart). Use after discover_api to save a working pattern.
Code runs as async JS with: params, fetch, helpers.credentials(service), helpers.browserFetch(url, opts), helpers.store(service, key, val), helpers.query(collection, opts), helpers.insert(collection, data).

IMPORTANT: In create_tool code, use fetch() with explicit headers from helpers.credentials() — NOT authenticated_fetch (which can't set CSRF headers). Example:
  const creds = helpers.credentials("linkedin");
  const res = await fetch(url, { headers: { "Cookie": "li_at=" + creds.li_at, "csrf-token": creds.jsessionid } });

## Collections — persistent structured storage
Create SQLite tables on the fly with collection_create. Use for: tracking state across sessions, storing scraped data, content calendars, monitoring snapshots. Full-text search built in.

## diff_monitor — watch anything for changes
Monitor any URL or API endpoint for changes. Stores snapshots in collections, compares on each run, reports diffs. Use for price tracking, job posting changes, competitor monitoring, or any "tell me when X changes" request.`;

const server = new McpServer(
    { name: "neo", version: "1.0.0" },
    { instructions: NEO_INSTRUCTIONS },
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(obj: any): string {
    return JSON.stringify(obj, null, 2);
}

// In-memory credential cache for when db is unavailable (e.g. Linux VM / Cowork)
const memCredentials = new Map<string, Record<string, string>>();

function getAuth(service: string): Record<string, string> {
    // Try database first, fall back to in-memory cache
    try {
        const creds = db.getCredentials(service);
        if (creds && Object.keys(creds).length > 0) return creds;
    } catch {
        // db unavailable — use in-memory cache
    }
    const mem = memCredentials.get(service);
    if (mem && Object.keys(mem).length > 0) return mem;
    throw new Error(`No credentials for "${service}". Use extract_auth to grab tokens from the browser first.`);
}

function storeAuthInMemory(service: string, creds: Record<string, string>) {
    const existing = memCredentials.get(service) || {};
    memCredentials.set(service, { ...existing, ...creds });
}

/** Build the credential service key, e.g. "linkedin" or "linkedin:business" */
function profileKey(service: string, profile?: string): string {
    return profile ? `${service}:${profile}` : service;
}

function getLinkedInAuth(profile?: string): linkedin.LinkedInAuth {
    const creds = getAuth(profileKey("linkedin", profile));
    if (!creds.li_at) throw new Error(`Missing li_at token. Run extract_auth for linkedin${profile ? ` (profile: ${profile})` : ""}.`);
    return { li_at: creds.li_at, jsessionid: creds.jsessionid || "" };
}

function getTwitterAuth(profile?: string): twitter.TwitterAuth {
    const creds = getAuth(profileKey("twitter", profile));
    if (!creds.auth_token) throw new Error(`Missing auth_token. Run extract_auth for twitter${profile ? ` (profile: ${profile})` : ""}.`);
    return { auth_token: creds.auth_token, csrf_token: creds.csrf_token || "" };
}

async function getGmailAuth(profile?: string): Promise<gmail.GmailAuth> {
    const creds = getAuth(profileKey("gmail", profile));
    if (!creds.refresh_token) throw new Error(`Gmail not connected${profile ? ` for profile "${profile}"` : ""}. Use gmail_connect to authenticate.`);
    const access_token = await gmail.refreshAccessToken(creds.refresh_token, profile || "default");
    return { access_token };
}

async function getGCalAuth(profile?: string): Promise<gcal.GCalAuth> {
    const creds = getAuth(profileKey("gcal", profile));
    if (!creds.refresh_token) throw new Error(`Google Calendar not connected${profile ? ` for profile "${profile}"` : ""}. Use gcal_connect to authenticate.`);
    const access_token = await gcal.refreshAccessToken(creds.refresh_token, profile || "default");
    return { access_token };
}

async function getGDriveAuth(profile?: string): Promise<gdrive.GDriveAuth> {
    const creds = getAuth(profileKey("gdrive", profile));
    if (!creds.refresh_token) throw new Error(`Google Drive not connected${profile ? ` for profile "${profile}"` : ""}. Use gdrive_connect to authenticate.`);
    const access_token = await gdrive.refreshAccessToken(creds.refresh_token, profile || "default");
    return { access_token };
}

function getGitHubAuth(profile?: string): github.GitHubAuth {
    const creds = getAuth(profileKey("github", profile));
    let token = creds.token || creds.access_token || creds.pat || "";
    // If no token stored, try extracting from gh CLI
    if (!token) {
        try {
            const result = require("child_process").execSync("gh auth token 2>/dev/null", { encoding: "utf-8", timeout: 5000 }).trim();
            if (result && result.startsWith("gh")) {
                token = result;
                // Store for future use
                try { db.storeCredential(profileKey("github", profile), "token", token); } catch {}
            }
        } catch {}
    }
    if (!token) throw new Error('GitHub requires a Personal Access Token. Either: (1) Run `gh auth login` in terminal, or (2) Use store_credential("github", "token", "ghp_YOUR_TOKEN") with a PAT from https://github.com/settings/tokens');
    return { token, _cookies: creds._cookies };
}

function getNotionAuth(profile?: string): notion.NotionAuth {
    const creds = getAuth(profileKey("notion", profile));
    const token = creds.token_v2 || "";
    if (!token && !creds._cookies) throw new Error(`Missing token_v2. Run extract_auth for notion${profile ? ` (profile: ${profile})` : ""}.`);
    return { token_v2: token, _cookies: creds._cookies };
}

function getDiscordAuth(profile?: string): discord.DiscordAuth {
    const creds = getAuth(profileKey("discord", profile));
    const token = creds.token || "";
    if (!token) throw new Error(`Discord not connected. Run extract_auth("discord") first${profile ? ` (profile: ${profile})` : ""}.`);
    return { token, _cookies: creds._cookies };
}

function getSlackAuth(profile?: string): slack.SlackAuth {
    const creds = getAuth(profileKey("slack", profile));
    const token = creds.xoxc_token || creds.token || creds.xoxc || creds.xoxp || creds.xoxb;
    if (!token) throw new Error(`Missing Slack token (have keys: ${Object.keys(creds).join(", ")}). Run extract_auth for slack${profile ? ` (profile: ${profile})` : ""}.`);
    // Prefer full cookie jar, fall back to just the d cookie
    return { token, cookie: creds._cookies || (creds.d_cookie ? `d=${creds.d_cookie}` : undefined) };
}


// ── Auth Extraction ──────────────────────────────────────────────────────────

server.tool(
    "extract_auth",
    "Extract auth tokens from the user's logged-in browser session. Supports: slack, discord, linkedin, twitter, github, notion, or any domain. Tokens are stored automatically for future API calls. Use the profile parameter to store credentials under a named profile (e.g. profile='business' stores as 'linkedin:business').",
    {
        service: z.string().describe("Service name or domain"),
        profile: z.string().optional().describe("Profile name (e.g. 'personal', 'business'). Omit to use the default profile."),
    },
    async ({ service, profile }) => {
        if (!isBridgeConnected()) {
            return { content: [{ type: "text", text: "Browser extension not connected. Install the Neo Bridge extension and make sure Chrome is running." }] };
        }
        const result = await browserCommand("extract_auth", { service });
        const storageKey = profileKey(service, profile);
        // Store extracted tokens in db + in-memory fallback
        const creds: Record<string, string> = {};
        for (const [key, value] of Object.entries(result)) {
            if (key === "service" || !value || typeof value !== "string") continue;
            creds[key] = value as string;
            try { db.storeCredential(storageKey, key, value as string); } catch {}
        }
        // Store full cookie jar as a cookie header string
        if (Array.isArray(result.cookies) && result.cookies.length > 0) {
            const cookieHeader = result.cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
            creds._cookies = cookieHeader;
            try { db.storeCredential(storageKey, "_cookies", cookieHeader); } catch {}
        }
        storeAuthInMemory(storageKey, creds);
        const label = profile ? ` as profile "${profile}"` : "";
        return { content: [{ type: "text", text: `Stored${label}.\n${json(result)}` }] };
    }
);

// ── Authenticated Fetch (ANY website) ────────────────────────────────────────

server.tool(
    "authenticated_fetch",
    `Make an HTTP request from the browser's context, carrying the page's cookies, auth, and session. Works on ANY website the user is logged into.

This is the meta-tool for building integrations on the fly. If no pre-built tool exists for a service:
1. Use discover_api to find the site's API endpoints
2. Use authenticated_fetch to call them
3. Use collection_create to save the discovered API pattern (endpoint, method, headers) so you can reuse it next time without rediscovering`,
    {
        url: z.string().describe("URL to fetch"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method (default GET)"),
        headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
        body: z.string().optional().describe("Request body"),
    },
    async ({ url, method, headers, body }) => {
        if (!isBridgeConnected()) {
            return { content: [{ type: "text", text: "Browser extension not connected." }] };
        }
        const result = await browserCommand("browser_fetch", { url, method, headers, body, credentials: "include" });
        const text = typeof result === "string" ? result : json(result);
        return { content: [{ type: "text", text: text.slice(0, 50000) }] };
    }
);

server.tool(
    "network_capture",
    "Start/stop/clear network request capture in the browser. Use network_requests to list and network_request_detail to inspect.",
    {
        action: z.enum(["start", "stop", "clear"]),
        filters: z.array(z.string()).optional().describe('URL substrings to capture, e.g. ["api.", "graphql"]. Empty = all.'),
        navigate: z.string().optional().describe("URL to navigate to after starting capture"),
    },
    async ({ action, filters, navigate }) => {
        if (!isBridgeConnected()) {
            return { content: [{ type: "text", text: "Browser extension not connected." }] };
        }
        if (action === "start") {
            await browserCommand("network_start_capture", { filters: filters || [] });
            if (navigate) await browserCommand("navigate", { url: navigate });
            return { content: [{ type: "text", text: "Capture started." }] };
        }
        if (action === "stop") {
            await browserCommand("network_stop_capture");
            return { content: [{ type: "text", text: "Capture stopped." }] };
        }
        await browserCommand("network_clear");
        return { content: [{ type: "text", text: "Capture cleared." }] };
    }
);

server.tool(
    "network_requests",
    "List captured network requests. Returns id, method, status, URL. Use network_request_detail to get full headers/body for a specific request.",
    {
        filter: z.string().optional().describe("Filter by URL/method/type substring"),
        limit: z.number().optional(),
    },
    async ({ filter, limit }) => {
        if (!isBridgeConnected()) {
            return { content: [{ type: "text", text: "Browser extension not connected." }] };
        }
        const data = await browserCommand("network_list", { filter, limit: limit || 100 });
        const entries = data?.requests || [];
        const lines = entries.map((r: any) =>
            `[${r.id}] ${r.method} ${r.status || "?"} ${r.url}`
        );
        return { content: [{ type: "text", text: lines.length > 0 ? `${data.total} requests captured:\n${lines.join("\n")}` : "No requests captured." }] };
    }
);

server.tool(
    "network_request_detail",
    "Get full details for a captured request — request headers, response headers, and body. Pass the id from network_requests.",
    {
        id: z.string().describe("Request ID from network_requests"),
    },
    async ({ id }) => {
        if (!isBridgeConnected()) {
            return { content: [{ type: "text", text: "Browser extension not connected." }] };
        }
        const detail = await browserCommand("network_get_request", { id });
        return { content: [{ type: "text", text: json(detail) }] };
    }
);

server.tool(
    "bridge_status",
    "Check if the Neo Browser Bridge extension is connected.",
    {},
    async () => {
        return { content: [{ type: "text", text: isBridgeConnected() ? "Connected." : "Not connected. Make sure Chrome is running with the Neo Bridge extension." }] };
    }
);

// ── LinkedIn ─────────────────────────────────────────────────────────────────

const profileParam = { profile: z.string().optional().describe("Credential profile to use (e.g. 'personal', 'business'). Omit for default.") };

server.tool(
    "linkedin_profile",
    "Get a LinkedIn user's profile. Pass the vanity name (URL slug, e.g. 'nirupambhowmick').",
    { vanity_name: z.string(), ...profileParam },
    async ({ vanity_name, profile }) => {
        const result = await linkedin.getProfile(getLinkedInAuth(profile), vanity_name);
        return { content: [{ type: "text", text: json(result) }] };
    }
);

server.tool(
    "linkedin_my_posts",
    "Get your own LinkedIn posts with engagement metrics (likes, comments, reposts, impressions).",
    { count: z.number().optional().describe("Number of posts (default 20)"), ...profileParam },
    async ({ count, profile }) => {
        const posts = await linkedin.getMyPosts(getLinkedInAuth(profile), count || 20);
        return { content: [{ type: "text", text: json(posts) }] };
    }
);

server.tool(
    "linkedin_profile_posts",
    "Get a LinkedIn user's posts by their vanity name (URL slug).",
    { vanity_name: z.string().describe("LinkedIn vanity name (e.g. 'bill-gates')"), count: z.number().optional().describe("Number of posts (default 20)"), ...profileParam },
    async ({ vanity_name, count, profile }) => {
        const posts = await linkedin.getProfilePosts(getLinkedInAuth(profile), vanity_name, count || 20);
        return { content: [{ type: "text", text: json(posts) }] };
    }
);

server.tool(
    "linkedin_feed",
    "Get your LinkedIn feed.",
    { count: z.number().optional().describe("Number of posts (default 20)"), ...profileParam },
    async ({ count, profile }) => {
        const posts = await linkedin.getFeed(getLinkedInAuth(profile), count || 20);
        return { content: [{ type: "text", text: json(posts) }] };
    }
);

server.tool(
    "linkedin_post",
    "Create a LinkedIn post.",
    { text: z.string().describe("Post content"), ...profileParam },
    async ({ text, profile }) => {
        const result = await linkedin.createPost(getLinkedInAuth(profile), text);
        return { content: [{ type: "text", text: json(result) }] };
    }
);

server.tool(
    "linkedin_search",
    "Search for people on LinkedIn.",
    { query: z.string(), count: z.number().optional(), ...profileParam },
    async ({ query, count, profile }) => {
        const results = await linkedin.searchPeople(getLinkedInAuth(profile), query, count || 10);
        return { content: [{ type: "text", text: json(results) }] };
    }
);

server.tool(
    "linkedin_connections",
    "List your LinkedIn connections.",
    { count: z.number().optional(), ...profileParam },
    async ({ count, profile }) => {
        const results = await linkedin.getConnections(getLinkedInAuth(profile), count || 50);
        return { content: [{ type: "text", text: json(results) }] };
    }
);

server.tool(
    "linkedin_conversations",
    "List your recent LinkedIn message conversations.",
    { count: z.number().optional().describe("Number of conversations (default 20)"), ...profileParam },
    async ({ count, profile }) => {
        const results = await linkedin.getConversations(getLinkedInAuth(profile), count || 20);
        return { content: [{ type: "text", text: json(results) }] };
    }
);

server.tool(
    "linkedin_messages",
    "Get messages in a specific LinkedIn conversation. Pass the conversationId from linkedin_conversations.",
    { conversation_id: z.string().describe("Conversation ID or URN from linkedin_conversations"), count: z.number().optional(), ...profileParam },
    async ({ conversation_id, count, profile }) => {
        const results = await linkedin.getConversationMessages(getLinkedInAuth(profile), conversation_id, count || 20);
        return { content: [{ type: "text", text: json(results) }] };
    }
);

server.tool(
    "linkedin_send_message",
    "Send a LinkedIn message to a connection. Pass their profile URN or vanity name (URL slug).",
    { recipient: z.string().describe("Recipient's vanity name or member URN"), message: z.string().describe("Message text"), ...profileParam },
    async ({ recipient, message, profile }) => {
        const result = await linkedin.sendMessage(getLinkedInAuth(profile), recipient, message);
        return { content: [{ type: "text", text: json(result) }] };
    }
);

server.tool(
    "linkedin_react",
    "React to a LinkedIn post (like, celebrate, support, love, insightful, funny).",
    { post_urn: z.string().describe("Post URN from linkedin_feed or linkedin_my_posts"), reaction: z.enum(["LIKE", "CELEBRATE", "SUPPORT", "LOVE", "INSIGHTFUL", "FUNNY"]).optional().describe("Reaction type (default LIKE)"), ...profileParam },
    async ({ post_urn, reaction, profile }) => {
        const result = await linkedin.reactToPost(getLinkedInAuth(profile), post_urn, reaction || "LIKE");
        return { content: [{ type: "text", text: json(result) }] };
    }
);

server.tool(
    "linkedin_comment",
    "Comment on a LinkedIn post.",
    { post_urn: z.string().describe("Post URN"), text: z.string().describe("Comment text"), ...profileParam },
    async ({ post_urn, text, profile }) => {
        const result = await linkedin.commentOnPost(getLinkedInAuth(profile), post_urn, text);
        return { content: [{ type: "text", text: json(result) }] };
    }
);

server.tool(
    "linkedin_post_comments",
    "Get comments on a LinkedIn post.",
    { post_urn: z.string().describe("Post URN"), count: z.number().optional(), ...profileParam },
    async ({ post_urn, count, profile }) => {
        const results = await linkedin.getPostComments(getLinkedInAuth(profile), post_urn, count || 20);
        return { content: [{ type: "text", text: json(results) }] };
    }
);

server.tool(
    "linkedin_notifications",
    "Get your recent LinkedIn notifications.",
    { count: z.number().optional().describe("Number of notifications (default 20)"), ...profileParam },
    async ({ count, profile }) => {
        const results = await linkedin.getNotifications(getLinkedInAuth(profile), count || 20);
        return { content: [{ type: "text", text: json(results) }] };
    }
);

server.tool(
    "linkedin_send_connection",
    "Send a connection request to a LinkedIn user.",
    { vanity_name: z.string().describe("Recipient's vanity name (URL slug)"), message: z.string().optional().describe("Optional personalized message"), ...profileParam },
    async ({ vanity_name, message, profile }) => {
        const result = await linkedin.sendConnectionRequest(getLinkedInAuth(profile), vanity_name, message);
        return { content: [{ type: "text", text: json(result) }] };
    }
);

server.tool(
    "linkedin_invitations",
    "Get your pending connection requests (received).",
    { count: z.number().optional(), ...profileParam },
    async ({ count, profile }) => {
        const results = await linkedin.getInvitations(getLinkedInAuth(profile), count || 20);
        return { content: [{ type: "text", text: json(results) }] };
    }
);

server.tool(
    "linkedin_respond_invitation",
    "Accept or decline a pending connection request.",
    { invitation_id: z.string().describe("Invitation ID or URN from linkedin_invitations"), accept: z.boolean().describe("true to accept, false to decline"), ...profileParam },
    async ({ invitation_id, accept, profile }) => {
        const result = await linkedin.respondToInvitation(getLinkedInAuth(profile), invitation_id, accept);
        return { content: [{ type: "text", text: json(result) }] };
    }
);

// ── Twitter/X ────────────────────────────────────────────────────────────────

server.tool(
    "twitter_profile",
    "Get a Twitter/X user's profile.",
    { screen_name: z.string(), ...profileParam },
    async ({ screen_name, profile }) => {
        const result = await twitter.getProfile(getTwitterAuth(profile), screen_name);
        return { content: [{ type: "text", text: json(result) }] };
    }
);

server.tool(
    "twitter_user_tweets",
    "Get a user's tweets with engagement metrics.",
    { screen_name: z.string(), count: z.number().optional(), ...profileParam },
    async ({ screen_name, count, profile }) => {
        const tweets = await twitter.getUserTweets(getTwitterAuth(profile), screen_name, count || 20);
        return { content: [{ type: "text", text: json(tweets) }] };
    }
);

server.tool(
    "twitter_timeline",
    "Get your home timeline.",
    { count: z.number().optional(), ...profileParam },
    async ({ count, profile }) => {
        const tweets = await twitter.getTimeline(getTwitterAuth(profile), count || 20);
        return { content: [{ type: "text", text: json(tweets) }] };
    }
);

server.tool(
    "twitter_post",
    "Post a tweet. Optionally reply to another tweet.",
    { text: z.string(), reply_to: z.string().optional().describe("Tweet ID to reply to"), ...profileParam },
    async ({ text, reply_to, profile }) => {
        const result = await twitter.createTweet(getTwitterAuth(profile), text, reply_to);
        return { content: [{ type: "text", text: json(result) }] };
    }
);

server.tool(
    "twitter_search",
    "Search tweets.",
    { query: z.string(), count: z.number().optional(), ...profileParam },
    async ({ query, count, profile }) => {
        const tweets = await twitter.searchTweets(getTwitterAuth(profile), query, count || 20);
        return { content: [{ type: "text", text: json(tweets) }] };
    }
);

// ── GitHub ────────────────────────────────────────────────────────────────────

server.tool("github_me", "Get your authenticated GitHub profile.", { ...profileParam },
    async ({ profile }) => ({ content: [{ type: "text", text: json(await github.getAuthenticatedUser(getGitHubAuth(profile))) }] }));
server.tool("github_user", "Get a GitHub user's profile.", { username: z.string(), ...profileParam },
    async ({ username, profile }) => ({ content: [{ type: "text", text: json(await github.getUserProfile(getGitHubAuth(profile), username)) }] }));
server.tool("github_repos", "List your GitHub repos.", { count: z.number().optional(), sort: z.enum(["updated", "created", "pushed", "full_name"]).optional(), ...profileParam },
    async ({ count, sort, profile }) => ({ content: [{ type: "text", text: json(await github.listMyRepos(getGitHubAuth(profile), count || 30, sort || "updated")) }] }));
server.tool("github_repo", "Get details about a GitHub repo.", { owner: z.string(), repo: z.string(), ...profileParam },
    async ({ owner, repo, profile }) => ({ content: [{ type: "text", text: json(await github.getRepo(getGitHubAuth(profile), owner, repo)) }] }));
server.tool("github_search_repos", "Search GitHub repositories.", { query: z.string(), count: z.number().optional(), ...profileParam },
    async ({ query, count, profile }) => ({ content: [{ type: "text", text: json(await github.searchRepos(getGitHubAuth(profile), query, count || 20)) }] }));
server.tool("github_issues", "List issues for a repo.", { owner: z.string(), repo: z.string(), state: z.enum(["open", "closed", "all"]).optional(), labels: z.string().optional(), count: z.number().optional(), ...profileParam },
    async ({ owner, repo, state, labels, count, profile }) => ({ content: [{ type: "text", text: json(await github.listIssues(getGitHubAuth(profile), owner, repo, { state, labels, count })) }] }));
server.tool("github_issue", "Get a specific issue.", { owner: z.string(), repo: z.string(), number: z.number(), ...profileParam },
    async ({ owner, repo, number, profile }) => ({ content: [{ type: "text", text: json(await github.getIssue(getGitHubAuth(profile), owner, repo, number)) }] }));
server.tool("github_create_issue", "Create a GitHub issue.", { owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional(), ...profileParam },
    async ({ owner, repo, title, body, labels, assignees, profile }) => ({ content: [{ type: "text", text: json(await github.createIssue(getGitHubAuth(profile), owner, repo, title, body, labels, assignees)) }] }));
server.tool("github_comment_issue", "Comment on a GitHub issue or PR.", { owner: z.string(), repo: z.string(), number: z.number(), body: z.string(), ...profileParam },
    async ({ owner, repo, number, body, profile }) => ({ content: [{ type: "text", text: json(await github.commentOnIssue(getGitHubAuth(profile), owner, repo, number, body)) }] }));
server.tool("github_prs", "List pull requests for a repo.", { owner: z.string(), repo: z.string(), state: z.enum(["open", "closed", "all"]).optional(), count: z.number().optional(), ...profileParam },
    async ({ owner, repo, state, count, profile }) => ({ content: [{ type: "text", text: json(await github.listPRs(getGitHubAuth(profile), owner, repo, { state, count })) }] }));
server.tool("github_pr", "Get details about a pull request.", { owner: z.string(), repo: z.string(), number: z.number(), ...profileParam },
    async ({ owner, repo, number, profile }) => ({ content: [{ type: "text", text: json(await github.getPR(getGitHubAuth(profile), owner, repo, number)) }] }));
server.tool("github_pr_files", "Get files changed in a pull request.", { owner: z.string(), repo: z.string(), number: z.number(), ...profileParam },
    async ({ owner, repo, number, profile }) => ({ content: [{ type: "text", text: json(await github.getPRFiles(getGitHubAuth(profile), owner, repo, number)) }] }));
server.tool("github_create_pr", "Create a pull request.", { owner: z.string(), repo: z.string(), title: z.string(), head: z.string(), base: z.string(), body: z.string().optional(), draft: z.boolean().optional(), ...profileParam },
    async ({ owner, repo, title, head, base, body, draft, profile }) => ({ content: [{ type: "text", text: json(await github.createPR(getGitHubAuth(profile), owner, repo, title, head, base, body, draft)) }] }));
server.tool("github_merge_pr", "Merge a pull request.", { owner: z.string(), repo: z.string(), number: z.number(), method: z.enum(["merge", "squash", "rebase"]).optional(), commit_message: z.string().optional(), ...profileParam },
    async ({ owner, repo, number, method, commit_message, profile }) => ({ content: [{ type: "text", text: json(await github.mergePR(getGitHubAuth(profile), owner, repo, number, method || "merge", commit_message)) }] }));
server.tool("github_pr_reviews", "Get reviews on a pull request.", { owner: z.string(), repo: z.string(), number: z.number(), ...profileParam },
    async ({ owner, repo, number, profile }) => ({ content: [{ type: "text", text: json(await github.getPRReviews(getGitHubAuth(profile), owner, repo, number)) }] }));
server.tool("github_review_pr", "Submit a review on a pull request.", { owner: z.string(), repo: z.string(), number: z.number(), event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: z.string().optional(), ...profileParam },
    async ({ owner, repo, number, event, body, profile }) => ({ content: [{ type: "text", text: json(await github.createPRReview(getGitHubAuth(profile), owner, repo, number, event, body)) }] }));
server.tool("github_notifications", "Get your GitHub notifications.", { count: z.number().optional(), all: z.boolean().optional(), ...profileParam },
    async ({ count, all, profile }) => ({ content: [{ type: "text", text: json(await github.getNotifications(getGitHubAuth(profile), count || 30, all || false)) }] }));
server.tool("github_mark_notification_read", "Mark a notification as read.", { thread_id: z.string(), ...profileParam },
    async ({ thread_id, profile }) => { await github.markNotificationRead(getGitHubAuth(profile), thread_id); return { content: [{ type: "text", text: "Marked as read." }] }; });
server.tool("github_search_code", "Search code on GitHub.", { query: z.string(), count: z.number().optional(), ...profileParam },
    async ({ query, count, profile }) => ({ content: [{ type: "text", text: json(await github.searchCode(getGitHubAuth(profile), query, count || 20)) }] }));
server.tool("github_search_users", "Search GitHub users.", { query: z.string(), count: z.number().optional(), ...profileParam },
    async ({ query, count, profile }) => ({ content: [{ type: "text", text: json(await github.searchUsers(getGitHubAuth(profile), query, count || 20)) }] }));
server.tool("github_starred", "List your starred repos.", { count: z.number().optional(), ...profileParam },
    async ({ count, profile }) => ({ content: [{ type: "text", text: json(await github.listStarred(getGitHubAuth(profile), count || 30)) }] }));
server.tool("github_star", "Star a repo.", { owner: z.string(), repo: z.string(), ...profileParam },
    async ({ owner, repo, profile }) => { await github.starRepo(getGitHubAuth(profile), owner, repo); return { content: [{ type: "text", text: "Starred." }] }; });
server.tool("github_unstar", "Unstar a repo.", { owner: z.string(), repo: z.string(), ...profileParam },
    async ({ owner, repo, profile }) => { await github.unstarRepo(getGitHubAuth(profile), owner, repo); return { content: [{ type: "text", text: "Unstarred." }] }; });
server.tool("github_gists", "List your gists.", { count: z.number().optional(), ...profileParam },
    async ({ count, profile }) => ({ content: [{ type: "text", text: json(await github.listGists(getGitHubAuth(profile), count || 20)) }] }));
server.tool("github_create_gist", "Create a gist.", { files: z.record(z.string(), z.string()).describe("Filename → content map"), description: z.string().optional(), public: z.boolean().optional(), ...profileParam },
    async ({ files, description, public: isPublic, profile }) => ({ content: [{ type: "text", text: json(await github.createGist(getGitHubAuth(profile), files, description, isPublic || false)) }] }));
server.tool("github_actions", "List recent workflow runs for a repo.", { owner: z.string(), repo: z.string(), count: z.number().optional(), ...profileParam },
    async ({ owner, repo, count, profile }) => ({ content: [{ type: "text", text: json(await github.listWorkflowRuns(getGitHubAuth(profile), owner, repo, count || 10)) }] }));
server.tool("github_action_run", "Get details about a workflow run.", { owner: z.string(), repo: z.string(), run_id: z.number(), ...profileParam },
    async ({ owner, repo, run_id, profile }) => ({ content: [{ type: "text", text: json(await github.getWorkflowRun(getGitHubAuth(profile), owner, repo, run_id)) }] }));
server.tool("github_rerun_workflow", "Re-run a failed workflow.", { owner: z.string(), repo: z.string(), run_id: z.number(), ...profileParam },
    async ({ owner, repo, run_id, profile }) => { await github.rerunWorkflow(getGitHubAuth(profile), owner, repo, run_id); return { content: [{ type: "text", text: "Re-run triggered." }] }; });
server.tool("github_file", "Get file or directory contents from a repo.", { owner: z.string(), repo: z.string(), path: z.string(), ref: z.string().optional().describe("Branch, tag, or commit SHA"), ...profileParam },
    async ({ owner, repo, path, ref, profile }) => ({ content: [{ type: "text", text: json(await github.getFileContent(getGitHubAuth(profile), owner, repo, path, ref)) }] }));

// ── Google Calendar ───────────────────────────────────────────────────────────

server.tool("gcal_connect", "Connect a Google Calendar account via OAuth. Opens Google sign-in in the browser.",
    { profile: z.string().optional().describe("Account name (e.g. 'personal', 'work'). Omit for default.") },
    async ({ profile }) => {
        const authUrl = `http://127.0.0.1:${httpPort}/gcal/auth${profile ? `?profile=${profile}` : ""}`;
        try { await browserCommand("navigate", { url: authUrl }); } catch {}
        const storageKey = profileKey("gcal", profile);
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            const creds = memCredentials.get(storageKey);
            if (creds?.refresh_token) {
                const label = profile ? ` as "${profile}"` : "";
                return { content: [{ type: "text", text: `Google Calendar connected${label}.` }] };
            }
        }
        return { content: [{ type: "text", text: `Timed out. Visit ${authUrl} manually.` }] };
    }
);
server.tool("gcal_calendars", "List your Google Calendar calendars.", { ...profileParam },
    async ({ profile }) => ({ content: [{ type: "text", text: json(await gcal.listCalendars(await getGCalAuth(profile))) }] }));
server.tool("gcal_events", "List upcoming calendar events.", {
    calendar_id: z.string().optional().describe("Calendar ID (default: primary)"),
    time_min: z.string().optional().describe("Start time ISO 8601 (default: now)"),
    time_max: z.string().optional().describe("End time ISO 8601"),
    max_results: z.number().optional(),
    query: z.string().optional().describe("Free-text search"),
    ...profileParam,
}, async ({ calendar_id, time_min, time_max, max_results, query, profile }) => ({
    content: [{ type: "text", text: json(await gcal.listEvents(await getGCalAuth(profile), calendar_id || "primary", { timeMin: time_min, timeMax: time_max, maxResults: max_results, query })) }],
}));
server.tool("gcal_event", "Get a specific calendar event.", { calendar_id: z.string().optional(), event_id: z.string(), ...profileParam },
    async ({ calendar_id, event_id, profile }) => ({ content: [{ type: "text", text: json(await gcal.getEvent(await getGCalAuth(profile), calendar_id || "primary", event_id)) }] }));
server.tool("gcal_create_event", "Create a calendar event.", {
    summary: z.string(), description: z.string().optional(), location: z.string().optional(),
    start: z.string().describe("Start time (ISO 8601 datetime or YYYY-MM-DD for all-day)"),
    end: z.string().describe("End time (ISO 8601 datetime or YYYY-MM-DD for all-day)"),
    attendees: z.array(z.string()).optional().describe("Email addresses of attendees"),
    time_zone: z.string().optional(), calendar_id: z.string().optional(),
    recurrence: z.array(z.string()).optional().describe("RRULE strings, e.g. ['RRULE:FREQ=WEEKLY;COUNT=10']"),
    add_meet: z.boolean().optional().describe("Add a Google Meet link"),
    ...profileParam,
}, async ({ summary, description, location, start, end, attendees, time_zone, calendar_id, recurrence, add_meet, profile }) => ({
    content: [{ type: "text", text: json(await gcal.createEvent(await getGCalAuth(profile), calendar_id || "primary", { summary, description, location, start, end, attendees, timeZone: time_zone, recurrence, conferenceData: add_meet })) }],
}));
server.tool("gcal_update_event", "Update a calendar event.", {
    event_id: z.string(), calendar_id: z.string().optional(),
    summary: z.string().optional(), description: z.string().optional(), location: z.string().optional(),
    start: z.string().optional(), end: z.string().optional(), time_zone: z.string().optional(),
    ...profileParam,
}, async ({ event_id, calendar_id, summary, description, location, start, end, time_zone, profile }) => ({
    content: [{ type: "text", text: json(await gcal.updateEvent(await getGCalAuth(profile), calendar_id || "primary", event_id, { summary, description, location, start, end, timeZone: time_zone })) }],
}));
server.tool("gcal_delete_event", "Delete a calendar event.", { event_id: z.string(), calendar_id: z.string().optional(), ...profileParam },
    async ({ event_id, calendar_id, profile }) => { await gcal.deleteEvent(await getGCalAuth(profile), calendar_id || "primary", event_id); return { content: [{ type: "text", text: "Event deleted." }] }; });
server.tool("gcal_respond", "Respond to a calendar invite (accept/decline/tentative).", {
    event_id: z.string(), response: z.enum(["accepted", "declined", "tentative"]), calendar_id: z.string().optional(), ...profileParam,
}, async ({ event_id, response, calendar_id, profile }) => ({
    content: [{ type: "text", text: json(await gcal.respondToEvent(await getGCalAuth(profile), calendar_id || "primary", event_id, response)) }],
}));
server.tool("gcal_quick_add", "Create an event from natural language text (e.g. 'Lunch with John tomorrow at noon').", {
    text: z.string(), calendar_id: z.string().optional(), ...profileParam,
}, async ({ text, calendar_id, profile }) => ({
    content: [{ type: "text", text: json(await gcal.quickAddEvent(await getGCalAuth(profile), calendar_id || "primary", text)) }],
}));
server.tool("gcal_freebusy", "Check free/busy status for calendars.", {
    calendar_ids: z.array(z.string()).optional().describe("Calendar IDs (default: [primary])"),
    time_min: z.string().describe("Start time ISO 8601"),
    time_max: z.string().describe("End time ISO 8601"),
    ...profileParam,
}, async ({ calendar_ids, time_min, time_max, profile }) => ({
    content: [{ type: "text", text: json(await gcal.freeBusy(await getGCalAuth(profile), calendar_ids || ["primary"], time_min, time_max)) }],
}));

// ── Notion ─────────────────────────────────────────────────────────────────────

server.tool("notion_spaces", "List your Notion workspaces.", { ...profileParam },
    async ({ profile }) => ({ content: [{ type: "text", text: json(await notion.getSpaces(getNotionAuth(profile))) }] }));
server.tool("notion_search", "Search Notion pages and databases.", { query: z.string(), limit: z.number().optional(), type: z.string().optional().describe("Filter type: page, collection, etc."), ...profileParam },
    async ({ query, limit, type, profile }) => ({ content: [{ type: "text", text: json(await notion.search(getNotionAuth(profile), query, { limit, type })) }] }));
server.tool("notion_page", "Get a Notion page with its child blocks.", { page_id: z.string().describe("Page ID, UUID, or Notion URL"), ...profileParam },
    async ({ page_id, profile }) => ({ content: [{ type: "text", text: json(await notion.getPage(getNotionAuth(profile), page_id)) }] }));
server.tool("notion_page_content", "Get a Notion page's content as readable markdown text.", { page_id: z.string().describe("Page ID, UUID, or Notion URL"), ...profileParam },
    async ({ page_id, profile }) => ({ content: [{ type: "text", text: await notion.getPageContent(getNotionAuth(profile), page_id) }] }));
server.tool("notion_block", "Get a specific Notion block.", { block_id: z.string(), ...profileParam },
    async ({ block_id, profile }) => ({ content: [{ type: "text", text: json(await notion.getBlock(getNotionAuth(profile), block_id)) }] }));
server.tool("notion_create_page", "Create a new Notion page.", { parent_id: z.string().describe("Parent page ID or URL"), title: z.string(), content: z.string().optional().describe("Initial text content (one paragraph per line)"), ...profileParam },
    async ({ parent_id, title, content, profile }) => ({ content: [{ type: "text", text: json(await notion.createPage(getNotionAuth(profile), parent_id, title, content)) }] }));
server.tool("notion_append", "Append a block to a Notion page.", { page_id: z.string(), text: z.string(), type: z.enum(["text", "header", "sub_header", "bulleted_list", "numbered_list", "to_do", "toggle", "quote", "code", "divider"]).optional(), ...profileParam },
    async ({ page_id, text, type, profile }) => ({ content: [{ type: "text", text: json(await notion.appendBlock(getNotionAuth(profile), page_id, text, type || "text")) }] }));
server.tool("notion_update_block", "Update the text of a Notion block.", { block_id: z.string(), text: z.string(), ...profileParam },
    async ({ block_id, text, profile }) => ({ content: [{ type: "text", text: json(await notion.updateBlock(getNotionAuth(profile), block_id, text)) }] }));
server.tool("notion_delete_block", "Delete a Notion block.", { block_id: z.string(), ...profileParam },
    async ({ block_id, profile }) => { await notion.deleteBlock(getNotionAuth(profile), block_id); return { content: [{ type: "text", text: "Block deleted." }] }; });
server.tool("notion_database", "Query a Notion database (collection).", { collection_id: z.string(), view_id: z.string(), limit: z.number().optional(), query: z.string().optional(), ...profileParam },
    async ({ collection_id, view_id, limit, query, profile }) => ({ content: [{ type: "text", text: json(await notion.queryDatabase(getNotionAuth(profile), collection_id, view_id, { limit, query })) }] }));
server.tool("notion_recent", "Get your recently visited Notion pages.", { limit: z.number().optional(), ...profileParam },
    async ({ limit, profile }) => ({ content: [{ type: "text", text: json(await notion.getRecentPages(getNotionAuth(profile), limit || 20)) }] }));

// ── Discord ───────────────────────────────────────────────────────────────────

server.tool("discord_me", "Get your Discord profile.", { ...profileParam },
    async ({ profile }) => ({ content: [{ type: "text", text: json(await discord.getMe(getDiscordAuth(profile))) }] }));
server.tool("discord_guilds", "List your Discord servers.", { ...profileParam },
    async ({ profile }) => ({ content: [{ type: "text", text: json(await discord.listGuilds(getDiscordAuth(profile))) }] }));
server.tool("discord_guild", "Get Discord server details.", { guild_id: z.string(), ...profileParam },
    async ({ guild_id, profile }) => ({ content: [{ type: "text", text: json(await discord.getGuild(getDiscordAuth(profile), guild_id)) }] }));
server.tool("discord_channels", "List channels in a Discord server.", { guild_id: z.string(), ...profileParam },
    async ({ guild_id, profile }) => ({ content: [{ type: "text", text: json(await discord.listChannels(getDiscordAuth(profile), guild_id)) }] }));
server.tool("discord_messages", "Read messages from a Discord channel.", { channel_id: z.string(), limit: z.number().optional(), ...profileParam },
    async ({ channel_id, limit, profile }) => ({ content: [{ type: "text", text: json(await discord.readMessages(getDiscordAuth(profile), channel_id, limit || 50)) }] }));
server.tool("discord_send", "Send a message to a Discord channel.", { channel_id: z.string(), content: z.string(), ...profileParam },
    async ({ channel_id, content, profile }) => ({ content: [{ type: "text", text: json(await discord.sendMessage(getDiscordAuth(profile), channel_id, content)) }] }));
server.tool("discord_channel", "Get Discord channel info.", { channel_id: z.string(), ...profileParam },
    async ({ channel_id, profile }) => ({ content: [{ type: "text", text: json(await discord.getChannel(getDiscordAuth(profile), channel_id)) }] }));
server.tool("discord_search", "Search messages in a Discord server.", { guild_id: z.string(), query: z.string(), limit: z.number().optional(), ...profileParam },
    async ({ guild_id, query, limit, profile }) => ({ content: [{ type: "text", text: json(await discord.searchMessages(getDiscordAuth(profile), guild_id, query, limit || 25)) }] }));
server.tool("discord_dms", "List your Discord DM channels.", { ...profileParam },
    async ({ profile }) => ({ content: [{ type: "text", text: json(await discord.listDMs(getDiscordAuth(profile))) }] }));
server.tool("discord_read_dm", "Read DM messages.", { channel_id: z.string(), limit: z.number().optional(), ...profileParam },
    async ({ channel_id, limit, profile }) => ({ content: [{ type: "text", text: json(await discord.readDMs(getDiscordAuth(profile), channel_id, limit || 50)) }] }));
server.tool("discord_send_dm", "Send a DM to a user.", { user_id: z.string(), content: z.string(), ...profileParam },
    async ({ user_id, content, profile }) => ({ content: [{ type: "text", text: json(await discord.sendDM(getDiscordAuth(profile), user_id, content)) }] }));
server.tool("discord_react", "Add a reaction to a message.", { channel_id: z.string(), message_id: z.string(), emoji: z.string(), ...profileParam },
    async ({ channel_id, message_id, emoji, profile }) => { await discord.addReaction(getDiscordAuth(profile), channel_id, message_id, emoji); return { content: [{ type: "text", text: "Reaction added." }] }; });
server.tool("discord_unreact", "Remove a reaction from a message.", { channel_id: z.string(), message_id: z.string(), emoji: z.string(), ...profileParam },
    async ({ channel_id, message_id, emoji, profile }) => { await discord.removeReaction(getDiscordAuth(profile), channel_id, message_id, emoji); return { content: [{ type: "text", text: "Reaction removed." }] }; });
server.tool("discord_members", "List members of a Discord server.", { guild_id: z.string(), limit: z.number().optional(), ...profileParam },
    async ({ guild_id, limit, profile }) => ({ content: [{ type: "text", text: json(await discord.getGuildMembers(getDiscordAuth(profile), guild_id, limit || 100)) }] }));
server.tool("discord_user", "Get a Discord user's profile.", { user_id: z.string(), ...profileParam },
    async ({ user_id, profile }) => ({ content: [{ type: "text", text: json(await discord.getUserProfile(getDiscordAuth(profile), user_id)) }] }));

// ── Google Drive ──────────────────────────────────────────────────────────────

server.tool("gdrive_connect", "Connect a Google Drive account via OAuth.",
    { profile: z.string().optional().describe("Account name (e.g. 'personal', 'work')") },
    async ({ profile }) => {
        const authUrl = `http://127.0.0.1:${httpPort}/gdrive/auth${profile ? `?profile=${profile}` : ""}`;
        try { await browserCommand("navigate", { url: authUrl }); } catch {}
        const storageKey = profileKey("gdrive", profile);
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            const creds = memCredentials.get(storageKey);
            if (creds?.refresh_token) {
                return { content: [{ type: "text", text: `Google Drive connected${profile ? ` as "${profile}"` : ""}.` }] };
            }
        }
        return { content: [{ type: "text", text: `Timed out. Visit ${authUrl} manually.` }] };
    }
);
server.tool("gdrive_files", "List files in Google Drive.", {
    query: z.string().optional().describe("Drive search query (e.g. \"name contains 'report'\")"),
    folder_id: z.string().optional().describe("Folder ID to list contents of"),
    page_size: z.number().optional(),
    order_by: z.string().optional().describe("Sort order (e.g. 'modifiedTime desc')"),
    ...profileParam,
}, async ({ query, folder_id, page_size, order_by, profile }) => ({
    content: [{ type: "text", text: json(await gdrive.listFiles(await getGDriveAuth(profile), { query, folderId: folder_id, pageSize: page_size, orderBy: order_by })) }],
}));
server.tool("gdrive_file", "Get file metadata.", { file_id: z.string(), ...profileParam },
    async ({ file_id, profile }) => ({ content: [{ type: "text", text: json(await gdrive.getFile(await getGDriveAuth(profile), file_id)) }] }));
server.tool("gdrive_search", "Search files by name.", { query: z.string(), page_size: z.number().optional(), ...profileParam },
    async ({ query, page_size, profile }) => ({ content: [{ type: "text", text: json(await gdrive.searchFiles(await getGDriveAuth(profile), query, page_size)) }] }));
server.tool("gdrive_read", "Read file content (Google Docs→text, Sheets→CSV, others→download).", { file_id: z.string(), ...profileParam },
    async ({ file_id, profile }) => ({ content: [{ type: "text", text: json(await gdrive.getFileContent(await getGDriveAuth(profile), file_id)) }] }));
server.tool("gdrive_create", "Create a file in Google Drive.", {
    name: z.string(), content: z.string(), mime_type: z.string().optional(), folder_id: z.string().optional(), ...profileParam,
}, async ({ name, content, mime_type, folder_id, profile }) => ({
    content: [{ type: "text", text: json(await gdrive.createFile(await getGDriveAuth(profile), name, content, mime_type, folder_id)) }],
}));
server.tool("gdrive_update", "Update a file's content.", { file_id: z.string(), content: z.string(), mime_type: z.string().optional(), ...profileParam },
    async ({ file_id, content, mime_type, profile }) => ({ content: [{ type: "text", text: json(await gdrive.updateFile(await getGDriveAuth(profile), file_id, content, mime_type)) }] }));
server.tool("gdrive_delete", "Move a file to trash.", { file_id: z.string(), ...profileParam },
    async ({ file_id, profile }) => { await gdrive.deleteFile(await getGDriveAuth(profile), file_id); return { content: [{ type: "text", text: "File moved to trash." }] }; });
server.tool("gdrive_create_folder", "Create a folder.", { name: z.string(), parent_id: z.string().optional(), ...profileParam },
    async ({ name, parent_id, profile }) => ({ content: [{ type: "text", text: json(await gdrive.createFolder(await getGDriveAuth(profile), name, parent_id)) }] }));
server.tool("gdrive_shared_drives", "List shared drives.", { ...profileParam },
    async ({ profile }) => ({ content: [{ type: "text", text: json(await gdrive.listSharedDrives(await getGDriveAuth(profile))) }] }));
server.tool("gdrive_quota", "Get storage quota.", { ...profileParam },
    async ({ profile }) => ({ content: [{ type: "text", text: json(await gdrive.getStorageQuota(await getGDriveAuth(profile))) }] }));

// ── Collections (agent-designed data storage) ────────────────────────────────

server.tool(
    "collection_create",
    "Create a new data collection (SQLite table with FTS). Design your own schema — columns with types (text, number, boolean, date, json). Use this to store structured data you've gathered.",
    {
        name: z.string().describe("Collection name (lowercase, no spaces)"),
        description: z.string().describe("What this collection stores"),
        columns: z.array(z.object({
            name: z.string(),
            type: z.enum(["text", "number", "boolean", "date", "json"]),
            description: z.string().optional(),
        })),
    },
    async ({ name, description, columns }) => {
        const result = db.createCollection(name, description, columns);
        return { content: [{ type: "text", text: json(result) }] };
    }
);

server.tool(
    "collection_insert",
    "Insert a row into a collection.",
    {
        collection: z.string(),
        data: z.record(z.string(), z.any()).describe("Column values as key-value pairs"),
    },
    async ({ collection, data }) => {
        const result = db.collectionInsert(collection, data);
        return { content: [{ type: "text", text: json(result) }] };
    }
);

server.tool(
    "collection_query",
    "Query a collection. Supports full-text search, where filters, ordering, and pagination.",
    {
        collection: z.string(),
        search: z.string().optional().describe("Full-text search query"),
        where: z.record(z.string(), z.any()).optional().describe("Column filters, e.g. {status: 'active'}"),
        order_by: z.string().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
    },
    async ({ collection, search, where, order_by, limit, offset }) => {
        const result = db.collectionQuery(collection, { search, where, orderBy: order_by, limit, offset });
        return { content: [{ type: "text", text: json(result) }] };
    }
);

server.tool(
    "collection_list",
    "List all collections with their schemas.",
    {},
    async () => {
        const collections = db.listCollections();
        if (collections.length === 0) return { content: [{ type: "text", text: "No collections yet." }] };
        return { content: [{ type: "text", text: json(collections) }] };
    }
);

server.tool(
    "collection_update",
    "Update a row in a collection by ID.",
    {
        collection: z.string(),
        id: z.number().describe("Row ID to update"),
        data: z.record(z.string(), z.any()).describe("New values"),
    },
    async ({ collection, id, data }) => {
        const result = db.collectionUpdate(collection, id, data);
        return { content: [{ type: "text", text: result ? "Updated." : "Row not found." }] };
    }
);

server.tool(
    "collection_delete",
    "Delete a row from a collection by ID.",
    {
        collection: z.string(),
        id: z.number().describe("Row ID to delete"),
    },
    async ({ collection, id }) => {
        const result = db.collectionDelete(collection, id);
        return { content: [{ type: "text", text: result ? "Deleted." : "Row not found." }] };
    }
);

// ── Slack ─────────────────────────────────────────────────────────────────────

server.tool("slack_channels", "List Slack channels.", { ...profileParam },
    async ({ profile }) => ({ content: [{ type: "text", text: json(await slack.listChannels(getSlackAuth(profile))) }] }));

server.tool("slack_channel_info", "Get details about a Slack channel.", { channel: z.string().describe("Channel name or ID"), ...profileParam },
    async ({ channel, profile }) => ({ content: [{ type: "text", text: json(await slack.getChannelInfo(getSlackAuth(profile), channel)) }] }));

server.tool("slack_read", "Read messages from a Slack channel.", { channel: z.string(), limit: z.number().optional(), oldest: z.number().optional().describe("Unix timestamp ms — only messages after this"), latest: z.number().optional().describe("Unix timestamp ms — only messages before this"), ...profileParam },
    async ({ channel, limit, oldest, latest, profile }) => ({ content: [{ type: "text", text: json(await slack.readMessages(getSlackAuth(profile), channel, { limit: limit || 50, oldest, latest })) }] }));

server.tool("slack_thread", "Read a Slack thread.", { channel: z.string(), thread_ts: z.string().describe("Thread timestamp ID"), limit: z.number().optional(), ...profileParam },
    async ({ channel, thread_ts, limit, profile }) => ({ content: [{ type: "text", text: json(await slack.readThread(getSlackAuth(profile), channel, thread_ts, limit || 50)) }] }));

server.tool("slack_dms", "Read recent DMs.", { limit: z.number().optional(), ...profileParam },
    async ({ limit, profile }) => ({ content: [{ type: "text", text: json(await slack.readDMs(getSlackAuth(profile), limit || 20)) }] }));

server.tool("slack_search", "Search Slack messages.", { query: z.string(), limit: z.number().optional(), sort: z.enum(["score", "timestamp"]).optional(), ...profileParam },
    async ({ query, limit, sort, profile }) => ({ content: [{ type: "text", text: json(await slack.searchMessages(getSlackAuth(profile), query, { limit: limit || 20, sort })) }] }));

server.tool("slack_send", "Send a message to a Slack channel or DM.", { channel: z.string(), text: z.string(), thread_ts: z.string().optional().describe("Reply in thread"), ...profileParam },
    async ({ channel, text, thread_ts, profile }) => { const ts = await slack.postMessage(getSlackAuth(profile), channel, text, thread_ts); return { content: [{ type: "text", text: `Sent (ts: ${ts}).` }] }; });

server.tool("slack_react", "Add a reaction emoji to a message.", { channel: z.string(), timestamp: z.string(), emoji: z.string().describe("Emoji name without colons"), ...profileParam },
    async ({ channel, timestamp, emoji, profile }) => { await slack.addReaction(getSlackAuth(profile), channel, timestamp, emoji); return { content: [{ type: "text", text: "Reacted." }] }; });

server.tool("slack_unreact", "Remove a reaction from a message.", { channel: z.string(), timestamp: z.string(), emoji: z.string(), ...profileParam },
    async ({ channel, timestamp, emoji, profile }) => { await slack.removeReaction(getSlackAuth(profile), channel, timestamp, emoji); return { content: [{ type: "text", text: "Reaction removed." }] }; });

server.tool("slack_edit", "Edit a Slack message.", { channel: z.string(), timestamp: z.string(), text: z.string(), ...profileParam },
    async ({ channel, timestamp, text, profile }) => { await slack.updateMessage(getSlackAuth(profile), channel, timestamp, text); return { content: [{ type: "text", text: "Message updated." }] }; });

server.tool("slack_delete", "Delete a Slack message.", { channel: z.string(), timestamp: z.string(), ...profileParam },
    async ({ channel, timestamp, profile }) => { await slack.deleteMessage(getSlackAuth(profile), channel, timestamp); return { content: [{ type: "text", text: "Deleted." }] }; });

server.tool("slack_users", "List Slack workspace users.", { ...profileParam },
    async ({ profile }) => ({ content: [{ type: "text", text: json(await slack.listUsers(getSlackAuth(profile))) }] }));

server.tool("slack_user_profile", "Get a Slack user's profile.", { user_id: z.string(), ...profileParam },
    async ({ user_id, profile }) => ({ content: [{ type: "text", text: json(await slack.getUserProfile(getSlackAuth(profile), user_id)) }] }));

server.tool("slack_set_status", "Set your Slack status.", { text: z.string(), emoji: z.string().optional().describe("Status emoji e.g. :house_with_garden:"), expiration: z.number().optional().describe("Unix timestamp when status expires"), ...profileParam },
    async ({ text, emoji, expiration, profile }) => { await slack.setStatus(getSlackAuth(profile), text, emoji, expiration); return { content: [{ type: "text", text: "Status set." }] }; });

server.tool("slack_create_channel", "Create a Slack channel.", { name: z.string(), is_private: z.boolean().optional(), ...profileParam },
    async ({ name, is_private, profile }) => ({ content: [{ type: "text", text: json(await slack.createChannel(getSlackAuth(profile), name, is_private)) }] }));

server.tool("slack_archive_channel", "Archive a Slack channel.", { channel: z.string(), ...profileParam },
    async ({ channel, profile }) => { await slack.archiveChannel(getSlackAuth(profile), channel); return { content: [{ type: "text", text: "Archived." }] }; });

server.tool("slack_invite", "Invite users to a channel.", { channel: z.string(), user_ids: z.array(z.string()), ...profileParam },
    async ({ channel, user_ids, profile }) => { await slack.inviteToChannel(getSlackAuth(profile), channel, user_ids); return { content: [{ type: "text", text: "Invited." }] }; });

server.tool("slack_kick", "Remove a user from a channel.", { channel: z.string(), user_id: z.string(), ...profileParam },
    async ({ channel, user_id, profile }) => { await slack.kickFromChannel(getSlackAuth(profile), channel, user_id); return { content: [{ type: "text", text: "Removed." }] }; });

server.tool("slack_set_topic", "Set a channel's topic.", { channel: z.string(), topic: z.string(), ...profileParam },
    async ({ channel, topic, profile }) => { await slack.setChannelTopic(getSlackAuth(profile), channel, topic); return { content: [{ type: "text", text: "Topic set." }] }; });

server.tool("slack_set_purpose", "Set a channel's purpose.", { channel: z.string(), purpose: z.string(), ...profileParam },
    async ({ channel, purpose, profile }) => { await slack.setChannelPurpose(getSlackAuth(profile), channel, purpose); return { content: [{ type: "text", text: "Purpose set." }] }; });

server.tool("slack_pin", "Pin a message.", { channel: z.string(), timestamp: z.string(), ...profileParam },
    async ({ channel, timestamp, profile }) => { await slack.pinMessage(getSlackAuth(profile), channel, timestamp); return { content: [{ type: "text", text: "Pinned." }] }; });

server.tool("slack_unpin", "Unpin a message.", { channel: z.string(), timestamp: z.string(), ...profileParam },
    async ({ channel, timestamp, profile }) => { await slack.unpinMessage(getSlackAuth(profile), channel, timestamp); return { content: [{ type: "text", text: "Unpinned." }] }; });

server.tool("slack_pins", "List pinned messages in a channel.", { channel: z.string(), ...profileParam },
    async ({ channel, profile }) => ({ content: [{ type: "text", text: json(await slack.listPins(getSlackAuth(profile), channel)) }] }));

// ── Gmail ─────────────────────────────────────────────────────────────────────

server.tool("gmail_connect", "Connect a Gmail account via OAuth. Opens Google sign-in in the browser. Use profile to connect multiple accounts.",
    { profile: z.string().optional().describe("Account name (e.g. 'personal', 'work'). Omit for default.") },
    async ({ profile }) => {
        const authUrl = `http://127.0.0.1:${httpPort}/gmail/auth${profile ? `?profile=${profile}` : ""}`;
        try { await browserCommand("navigate", { url: authUrl }); } catch {}
        // Wait for callback to store tokens
        const storageKey = profileKey("gmail", profile);
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            const creds = memCredentials.get(storageKey);
            if (creds?.refresh_token) {
                const label = profile ? ` as "${profile}"` : "";
                return { content: [{ type: "text", text: `Gmail connected${label}${creds.email ? ` (${creds.email})` : ""}.` }] };
            }
        }
        return { content: [{ type: "text", text: `Timed out waiting for Gmail auth. Visit ${authUrl} manually.` }] };
    });

server.tool("gmail_profile", "Get Gmail profile info (email, message count).", { ...profileParam },
    async ({ profile }) => ({ content: [{ type: "text", text: json(await gmail.getProfile(await getGmailAuth(profile))) }] }));

server.tool("gmail_inbox", "Read your Gmail inbox.", { query: z.string().optional().describe("Gmail search query to filter"), max_results: z.number().optional(), page_token: z.string().optional(), ...profileParam },
    async ({ query, max_results, page_token, profile }) => ({ content: [{ type: "text", text: json(await gmail.getInbox(await getGmailAuth(profile), { query, maxResults: max_results || 20, pageToken: page_token })) }] }));

server.tool("gmail_search", "Search Gmail messages.", { query: z.string().describe("Gmail search query (same syntax as Gmail search bar)"), max_results: z.number().optional(), page_token: z.string().optional(), ...profileParam },
    async ({ query, max_results, page_token, profile }) => ({ content: [{ type: "text", text: json(await gmail.searchMail(await getGmailAuth(profile), query, max_results || 20, page_token)) }] }));

server.tool("gmail_read", "Read a specific email message.", { message_id: z.string(), ...profileParam },
    async ({ message_id, profile }) => ({ content: [{ type: "text", text: json(await gmail.getMessage(await getGmailAuth(profile), message_id)) }] }));

server.tool("gmail_thread", "Read an entire email thread.", { thread_id: z.string(), ...profileParam },
    async ({ thread_id, profile }) => ({ content: [{ type: "text", text: json(await gmail.getThread(await getGmailAuth(profile), thread_id)) }] }));

server.tool("gmail_send", "Send an email.", { to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional(), bcc: z.string().optional(), thread_id: z.string().optional().describe("Thread ID to reply in"), ...profileParam },
    async ({ to, subject, body, cc, bcc, thread_id, profile }) => ({ content: [{ type: "text", text: json(await gmail.sendEmail(await getGmailAuth(profile), to, subject, body, { cc, bcc, threadId: thread_id })) }] }));

server.tool("gmail_reply", "Reply to the last message in a thread.", { thread_id: z.string(), body: z.string(), ...profileParam },
    async ({ thread_id, body, profile }) => ({ content: [{ type: "text", text: json(await gmail.replyToThread(await getGmailAuth(profile), thread_id, body)) }] }));

server.tool("gmail_draft", "Create a draft email.", { to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional(), bcc: z.string().optional(), thread_id: z.string().optional(), ...profileParam },
    async ({ to, subject, body, cc, bcc, thread_id, profile }) => ({ content: [{ type: "text", text: json(await gmail.createDraft(await getGmailAuth(profile), to, subject, body, { cc, bcc, threadId: thread_id })) }] }));

server.tool("gmail_mark_read", "Mark an email as read.", { message_id: z.string(), ...profileParam },
    async ({ message_id, profile }) => { await gmail.markAsRead(await getGmailAuth(profile), message_id); return { content: [{ type: "text", text: "Marked as read." }] }; });

server.tool("gmail_archive", "Archive an email (remove from inbox).", { message_id: z.string(), ...profileParam },
    async ({ message_id, profile }) => { await gmail.archiveMessage(await getGmailAuth(profile), message_id); return { content: [{ type: "text", text: "Archived." }] }; });

server.tool("gmail_trash", "Move an email to trash.", { message_id: z.string(), ...profileParam },
    async ({ message_id, profile }) => { await gmail.trashMessage(await getGmailAuth(profile), message_id); return { content: [{ type: "text", text: "Trashed." }] }; });

server.tool("gmail_star", "Star an email.", { message_id: z.string(), ...profileParam },
    async ({ message_id, profile }) => { await gmail.starMessage(await getGmailAuth(profile), message_id); return { content: [{ type: "text", text: "Starred." }] }; });

server.tool("gmail_labels", "List all Gmail labels.", { ...profileParam },
    async ({ profile }) => ({ content: [{ type: "text", text: json(await gmail.listLabels(await getGmailAuth(profile))) }] }));

server.tool("gmail_label_create", "Create a Gmail label.", { name: z.string(), ...profileParam },
    async ({ name, profile }) => ({ content: [{ type: "text", text: json(await gmail.createLabel(await getGmailAuth(profile), name)) }] }));

server.tool("gmail_modify", "Add or remove labels from a message.", { message_id: z.string(), add_labels: z.array(z.string()).optional(), remove_labels: z.array(z.string()).optional(), ...profileParam },
    async ({ message_id, add_labels, remove_labels, profile }) => { await gmail.modifyMessage(await getGmailAuth(profile), message_id, add_labels || [], remove_labels || []); return { content: [{ type: "text", text: "Labels modified." }] }; });

// ── WhatsApp ─────────────────────────────────────────────────────────────────

server.tool(
    "whatsapp_connect",
    "Connect to WhatsApp. Opens a QR code in the browser on first use. Auto-reconnects after that.",
    {},
    async () => {
        const wa = await import("./integrations/whatsapp.js");
        const { state } = wa.getConnectionState();
        if (state === "connected") return { content: [{ type: "text", text: "WhatsApp already connected." }] };

        wa.connect().catch(() => {});

        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            const s = wa.getConnectionState();
            if (s.state === "connected") return { content: [{ type: "text", text: "WhatsApp connected." }] };
            if (s.state === "qr" && s.qr) {
                const qrUrl = `http://127.0.0.1:${httpPort}/whatsapp-qr`;
                try { await browserCommand("navigate", { url: qrUrl }); } catch {}
                const scanDeadline = Date.now() + 60000;
                while (Date.now() < scanDeadline) {
                    await new Promise(r => setTimeout(r, 2000));
                    if (wa.getConnectionState().state === "connected") {
                        return { content: [{ type: "text", text: "WhatsApp connected! QR code scanned successfully." }] };
                    }
                }
                return { content: [{ type: "text", text: `QR code opened in browser at ${qrUrl}. Scan it with WhatsApp (Linked Devices > Link a Device), then call whatsapp_connect again.` }] };
            }
            await new Promise(r => setTimeout(r, 500));
        }
        return { content: [{ type: "text", text: `WhatsApp connection state: ${wa.getConnectionState().state}. Try again.` }] };
    }
);

server.tool("whatsapp_chats", "List WhatsApp chats with last message and unread count.", { limit: z.number().optional() },
    async ({ limit }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getChats(limit || 30)) }] }; });

server.tool("whatsapp_search_chats", "Search WhatsApp chats by name.", { query: z.string(), limit: z.number().optional() },
    async ({ query, limit }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.searchChats(query, limit || 20)) }] }; });

server.tool("whatsapp_read", "Read messages from a WhatsApp chat with pagination and search.",
    { chat: z.string().describe("Chat ID, phone number, or contact name"), limit: z.number().optional(), offset: z.number().optional().describe("Skip N most recent messages"), query: z.string().optional().describe("Filter messages containing this text"), before: z.number().optional().describe("Unix timestamp cursor — only messages before this time") },
    async ({ chat, limit, offset, query, before }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.readMessages(chat, { limit: limit || 30, offset, query, before })) }] }; });

server.tool("whatsapp_search", "Search messages across all WhatsApp chats by text content.",
    { query: z.string(), chat: z.string().optional().describe("Limit search to a specific chat"), limit: z.number().optional() },
    async ({ query, chat, limit }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.searchMessages(query, { chatId: chat, limit: limit || 30 })) }] }; });

server.tool("whatsapp_send", "Send a WhatsApp text message.", { to: z.string().describe("Phone number, contact name, or chat ID"), text: z.string() },
    async ({ to, text }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.sendMessage(to, text)) }] }; });

server.tool("whatsapp_send_media", "Send media (image, video, document, audio, sticker) on WhatsApp.",
    { to: z.string(), type: z.enum(["image", "video", "document", "audio", "sticker"]), url: z.string().describe("File URL or local path"), caption: z.string().optional(), filename: z.string().optional(), mimetype: z.string().optional() },
    async ({ to, type, url, caption, filename, mimetype }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.sendMedia(to, { type, url, caption, filename, mimetype })) }] }; });

server.tool("whatsapp_send_location", "Send a location on WhatsApp.", { to: z.string(), latitude: z.number(), longitude: z.number(), name: z.string().optional() },
    async ({ to, latitude, longitude, name }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.sendLocation(to, latitude, longitude, name)) }] }; });

server.tool("whatsapp_send_contact", "Send a contact card on WhatsApp.", { to: z.string(), contact_name: z.string(), contact_phone: z.string().describe("Phone number without + prefix") },
    async ({ to, contact_name, contact_phone }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.sendContact(to, contact_name, contact_phone)) }] }; });

// WhatsApp Contacts & Profile
server.tool("whatsapp_check_number", "Check if a phone number is on WhatsApp.", { phone: z.string() },
    async ({ phone }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.checkOnWhatsApp(phone)) }] }; });

server.tool("whatsapp_find_contact", "Search contacts by name or phone number.", { query: z.string() },
    async ({ query }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.findContact(query)) }] }; });

server.tool("whatsapp_profile_pic", "Get profile picture URL for a contact or group.", { chat: z.string() },
    async ({ chat }) => { const wa = await import("./integrations/whatsapp.js"); const url = await wa.getProfilePicUrl(chat); return { content: [{ type: "text", text: url || "No profile picture." }] }; });

server.tool("whatsapp_status", "Get a contact's status/bio.", { chat: z.string() },
    async ({ chat }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getStatus(chat)) }] }; });

server.tool("whatsapp_update_status", "Update your WhatsApp status/bio.", { status: z.string() },
    async ({ status }) => { const wa = await import("./integrations/whatsapp.js"); await wa.updateMyStatus(status); return { content: [{ type: "text", text: "Status updated." }] }; });

server.tool("whatsapp_presence", "Send presence update (typing indicator, online, etc.).",
    { type: z.enum(["available", "unavailable", "composing", "paused", "recording"]), chat: z.string().optional().describe("Chat to show typing in") },
    async ({ type, chat }) => { const wa = await import("./integrations/whatsapp.js"); await wa.sendPresence(type, chat); return { content: [{ type: "text", text: `Presence set to ${type}.` }] }; });

server.tool("whatsapp_add_contact", "Create or update a contact.", { phone: z.string(), name: z.string() },
    async ({ phone, name }) => { const wa = await import("./integrations/whatsapp.js"); await wa.addOrEditContact(phone, name); return { content: [{ type: "text", text: `Contact ${name} saved.` }] }; });

// WhatsApp Chat Management
server.tool("whatsapp_chat_modify", "Archive, unarchive, mute, unmute, pin, or unpin a chat.",
    { chat: z.string(), action: z.enum(["archive", "unarchive", "mute", "unmute", "pin", "unpin"]) },
    async ({ chat, action }) => { const wa = await import("./integrations/whatsapp.js"); await wa.modifyChat(chat, action); return { content: [{ type: "text", text: `Chat ${action}d.` }] }; });

server.tool("whatsapp_star", "Star or unstar messages.", { chat: z.string(), message_ids: z.array(z.string()), star: z.boolean() },
    async ({ chat, message_ids, star }) => { const wa = await import("./integrations/whatsapp.js"); await wa.starMessages(chat, message_ids, star); return { content: [{ type: "text", text: star ? "Messages starred." : "Messages unstarred." }] }; });

server.tool("whatsapp_mark_read", "Mark a chat as read.", { chat: z.string() },
    async ({ chat }) => { const wa = await import("./integrations/whatsapp.js"); await wa.markRead(chat); return { content: [{ type: "text", text: "Marked as read." }] }; });

// WhatsApp Privacy
server.tool("whatsapp_block", "Block a contact.", { chat: z.string() },
    async ({ chat }) => { const wa = await import("./integrations/whatsapp.js"); await wa.blockContact(chat); return { content: [{ type: "text", text: "Blocked." }] }; });

server.tool("whatsapp_unblock", "Unblock a contact.", { chat: z.string() },
    async ({ chat }) => { const wa = await import("./integrations/whatsapp.js"); await wa.unblockContact(chat); return { content: [{ type: "text", text: "Unblocked." }] }; });

server.tool("whatsapp_blocklist", "List all blocked contacts.", {},
    async () => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getBlocklist()) }] }; });

// WhatsApp Groups
server.tool("whatsapp_group_info", "Get group metadata (members, description, settings).", { group: z.string() },
    async ({ group }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getGroupMetadata(group)) }] }; });

server.tool("whatsapp_group_create", "Create a new WhatsApp group.", { name: z.string(), participants: z.array(z.string()).describe("Phone numbers or JIDs") },
    async ({ name, participants }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.createGroup(name, participants)) }] }; });

server.tool("whatsapp_group_participants", "Add, remove, promote, or demote group members.",
    { group: z.string(), participants: z.array(z.string()), action: z.enum(["add", "remove", "promote", "demote"]) },
    async ({ group, participants, action }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.updateGroupParticipants(group, participants, action)) }] }; });

server.tool("whatsapp_group_update_name", "Change a group's name.", { group: z.string(), name: z.string() },
    async ({ group, name }) => { const wa = await import("./integrations/whatsapp.js"); await wa.updateGroupSubject(group, name); return { content: [{ type: "text", text: "Group name updated." }] }; });

server.tool("whatsapp_group_update_description", "Change a group's description.", { group: z.string(), description: z.string() },
    async ({ group, description }) => { const wa = await import("./integrations/whatsapp.js"); await wa.updateGroupDescription(group, description); return { content: [{ type: "text", text: "Group description updated." }] }; });

server.tool("whatsapp_groups_list", "List all groups you're participating in.", {},
    async () => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getAllGroups()) }] }; });

server.tool("whatsapp_group_invite", "Get the invite link for a group.", { group: z.string() },
    async ({ group }) => { const wa = await import("./integrations/whatsapp.js"); const code = await wa.getGroupInviteCode(group); return { content: [{ type: "text", text: `https://chat.whatsapp.com/${code}` }] }; });

server.tool("whatsapp_group_leave", "Leave a WhatsApp group.", { group: z.string() },
    async ({ group }) => { const wa = await import("./integrations/whatsapp.js"); await wa.leaveGroup(group); return { content: [{ type: "text", text: "Left group." }] }; });

// WhatsApp Newsletters/Channels
server.tool("whatsapp_newsletter_create", "Create a new WhatsApp channel.", { name: z.string(), description: z.string().optional() },
    async ({ name, description }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.createNewsletter(name, description)) }] }; });

server.tool("whatsapp_newsletter_follow", "Follow a WhatsApp channel.", { jid: z.string() },
    async ({ jid }) => { const wa = await import("./integrations/whatsapp.js"); await wa.followNewsletter(jid); return { content: [{ type: "text", text: "Followed." }] }; });

server.tool("whatsapp_newsletter_unfollow", "Unfollow a WhatsApp channel.", { jid: z.string() },
    async ({ jid }) => { const wa = await import("./integrations/whatsapp.js"); await wa.unfollowNewsletter(jid); return { content: [{ type: "text", text: "Unfollowed." }] }; });

server.tool("whatsapp_newsletter_messages", "Get messages from a WhatsApp channel.", { jid: z.string(), count: z.number().optional() },
    async ({ jid, count }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getNewsletterMessages(jid, count || 20)) }] }; });

server.tool("whatsapp_newsletter_info", "Get info about a WhatsApp channel.", { jid: z.string() },
    async ({ jid }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getNewsletterMetadata(jid)) }] }; });

// WhatsApp Business
server.tool("whatsapp_business_profile", "Get a business profile.", { chat: z.string() },
    async ({ chat }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getBusinessProfile(chat)) }] }; });

server.tool("whatsapp_catalog", "Get a business's product catalog.", { chat: z.string(), limit: z.number().optional() },
    async ({ chat, limit }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getCatalog(chat, limit || 50)) }] }; });

// ── Credential Management ────────────────────────────────────────────────────

server.tool(
    "list_credentials",
    "List all stored service credentials (keys only, not values).",
    {},
    async () => {
        const services = db.listConnectedServices();
        return { content: [{ type: "text", text: json(services) }] };
    }
);

server.tool(
    "store_credential",
    "Manually store a credential for a service.",
    {
        service: z.string(),
        key: z.string(),
        value: z.string(),
    },
    async ({ service, key, value }) => {
        db.storeCredential(service, key, value);
        return { content: [{ type: "text", text: `Stored ${key} for ${service}.` }] };
    }
);

server.tool(
    "list_profiles",
    "List all stored profiles for a service. Profiles are named credential sets (e.g. linkedin:personal, linkedin:business). The default profile has no suffix.",
    { service: z.string().describe("Service name, e.g. 'linkedin' or 'twitter'") },
    async ({ service }) => {
        const profiles = db.listProfiles(service);
        if (profiles.length === 0) return { content: [{ type: "text", text: `No credentials stored for "${service}".` }] };
        return { content: [{ type: "text", text: json(profiles) }] };
    }
);

// ── Analytics ────────────────────────────────────────────────────────────────

const ANALYTICS_COLLECTION = "neo_analytics";

function ensureAnalyticsCollection() {
    try {
        db.createCollection(ANALYTICS_COLLECTION, "Tracked social media posts for ongoing analytics monitoring", [
            { name: "service", type: "text", description: "linkedin or twitter" },
            { name: "post_id", type: "text", description: "Platform post ID" },
            { name: "post_url", type: "text", description: "URL of the post" },
            { name: "post_text", type: "text", description: "Post content snippet" },
            { name: "likes", type: "number", description: "Like count at last check" },
            { name: "comments", type: "number", description: "Comment count at last check" },
            { name: "shares", type: "number", description: "Share/repost count at last check" },
            { name: "impressions", type: "number", description: "Impression count at last check" },
            { name: "profile", type: "text", description: "Credential profile used" },
            { name: "tracked_at", type: "date", description: "When tracking started" },
            { name: "last_checked_at", type: "date", description: "Last time metrics were refreshed" },
        ]);
    } catch {
        // Collection already exists — that's fine
    }
}

server.tool(
    "content_monitor",
    "Fetch analytics on your recent posts for a service (linkedin or twitter). Returns engagement rates, best performing posts, and totals. For Twitter, pass your screen_name (handle) to fetch your own tweets.",
    { service: z.enum(["linkedin", "twitter"]), screen_name: z.string().optional().describe("Your Twitter screen name / handle (required for twitter service)"), count: z.number().optional().describe("Number of recent posts to analyse (default 20)"), ...profileParam },
    async ({ service, screen_name, count, profile }) => {
        if (service === "twitter" && !screen_name) {
            return { content: [{ type: "text", text: "screen_name is required for twitter. Pass your Twitter handle (e.g. screen_name='elonmusk')." }] };
        }
        const posts = service === "linkedin"
            ? await linkedin.getMyPosts(getLinkedInAuth(profile), count || 20)
            : await twitter.getUserTweets(getTwitterAuth(profile), screen_name!, count || 20);

        const items = Array.isArray(posts) ? posts : [];
        if (items.length === 0) return { content: [{ type: "text", text: "No posts found." }] };

        const metrics = items.map((p: any) => ({
            id: p.id || p.tweet_id,
            text: (p.text || p.content || "").slice(0, 120),
            likes: Number(p.likes || p.like_count || 0),
            comments: Number(p.comments || p.comment_count || p.reply_count || 0),
            shares: Number(p.shares || p.reposts || p.repost_count || p.retweet_count || 0),
            impressions: Number(p.impressions || p.impression_count || 0),
            posted_at: p.created_at || p.postedAt || "",
        }));

        const totalLikes = metrics.reduce((s: number, p: any) => s + p.likes, 0);
        const totalComments = metrics.reduce((s: number, p: any) => s + p.comments, 0);
        const totalShares = metrics.reduce((s: number, p: any) => s + p.shares, 0);
        const best = [...metrics].sort((a: any, b: any) => (b.likes + b.comments + b.shares) - (a.likes + a.comments + a.shares)).slice(0, 3);

        const report = {
            service,
            profile: profile || "default",
            posts_analysed: metrics.length,
            totals: { likes: totalLikes, comments: totalComments, shares: totalShares },
            averages: {
                likes: (totalLikes / metrics.length).toFixed(1),
                comments: (totalComments / metrics.length).toFixed(1),
                shares: (totalShares / metrics.length).toFixed(1),
            },
            top_posts: best,
            all_posts: metrics,
        };

        return { content: [{ type: "text", text: json(report) }] };
    }
);

server.tool(
    "track_post",
    "Add a post to the analytics tracking collection for ongoing monitoring. Stores current engagement metrics in the neo_analytics collection.",
    {
        service: z.enum(["linkedin", "twitter"]),
        post_id: z.string().describe("Post ID or tweet ID"),
        post_url: z.string().optional().describe("URL of the post"),
        post_text: z.string().optional().describe("Post content snippet"),
        likes: z.number().optional(),
        comments: z.number().optional(),
        shares: z.number().optional(),
        impressions: z.number().optional(),
        ...profileParam,
    },
    async ({ service, post_id, post_url, post_text, likes, comments, shares, impressions, profile }) => {
        ensureAnalyticsCollection();
        const now = new Date().toISOString();
        const result = db.collectionInsert(ANALYTICS_COLLECTION, {
            service,
            post_id,
            post_url: post_url || "",
            post_text: (post_text || "").slice(0, 500),
            likes: likes || 0,
            comments: comments || 0,
            shares: shares || 0,
            impressions: impressions || 0,
            profile: profile || "default",
            tracked_at: now,
            last_checked_at: now,
        });
        return { content: [{ type: "text", text: `Tracking post ${post_id} (id=${result.id}).` }] };
    }
);

server.tool(
    "analytics_report",
    "Generate a summary report of all tracked posts' performance. Shows engagement totals, averages, and top performers. Uses the neo_analytics collection.",
    { service: z.enum(["linkedin", "twitter"]).optional().describe("Filter by service (omit for all)"), ...profileParam },
    async ({ service, profile }) => {
        ensureAnalyticsCollection();
        const where: Record<string, any> = {};
        if (service) where.service = service;
        if (profile) where.profile = profile;
        const rows = db.collectionQuery(ANALYTICS_COLLECTION, { where: Object.keys(where).length ? where : undefined, limit: 500, orderBy: "created_at DESC" });

        if (rows.length === 0) return { content: [{ type: "text", text: "No tracked posts yet. Use track_post to start monitoring." }] };

        // Group by service
        const byService: Record<string, any[]> = {};
        for (const row of rows) {
            if (!byService[row.service]) byService[row.service] = [];
            byService[row.service].push(row);
        }

        const summary: Record<string, any> = {};
        for (const [svc, posts] of Object.entries(byService)) {
            const totalLikes = posts.reduce((s, p) => s + (p.likes || 0), 0);
            const totalComments = posts.reduce((s, p) => s + (p.comments || 0), 0);
            const totalShares = posts.reduce((s, p) => s + (p.shares || 0), 0);
            const best = [...posts].sort((a, b) => (b.likes + b.comments + b.shares) - (a.likes + a.comments + a.shares)).slice(0, 3);
            summary[svc] = {
                tracked_posts: posts.length,
                totals: { likes: totalLikes, comments: totalComments, shares: totalShares },
                averages: {
                    likes: (totalLikes / posts.length).toFixed(1),
                    comments: (totalComments / posts.length).toFixed(1),
                    shares: (totalShares / posts.length).toFixed(1),
                },
                top_posts: best.map((p) => ({ id: p.post_id, text: p.post_text, likes: p.likes, comments: p.comments, shares: p.shares, tracked_at: p.tracked_at })),
            };
        }

        return { content: [{ type: "text", text: json({ generated_at: new Date().toISOString(), filter: { service, profile }, ...summary }) }] };
    }
);

// ── Cross-Platform Content Repurposer ─────────────────────────────────────────

server.tool(
    "repurpose_content",
    `Repurpose content between social media platforms (LinkedIn ↔ Twitter). Analyzes the input text and transforms it to match the target platform's conventions, character limits, formatting style, and audience expectations. Returns ready-to-post content.`,
    {
        text: z.string().describe("The original content to repurpose"),
        from: z.enum(["linkedin", "twitter"]).describe("Source platform"),
        to: z.enum(["linkedin", "twitter"]).describe("Target platform"),
        tone: z.enum(["professional", "casual", "thought_leader", "storytelling"]).optional().describe("Desired tone (default: auto-detect from source)"),
        include_hashtags: z.boolean().optional().describe("Include relevant hashtags (default: true)"),
    },
    async ({ text, from, to, tone, include_hashtags }) => {
        const hashtagsEnabled = include_hashtags !== false;

        if (from === to) {
            return { content: [{ type: "text", text: "Source and target platforms are the same. No repurposing needed." }] };
        }

        const result: any = {
            original: { platform: from, text, char_count: text.length },
            repurposed: { platform: to },
        };

        if (from === "linkedin" && to === "twitter") {
            // LinkedIn → Twitter: condense long-form into tweet-sized content
            const lines = text.split("\n").filter(l => l.trim());
            const sentences = text.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/).filter(s => s.trim());

            // Strategy 1: Single tweet (best hook/takeaway)
            let tweet = "";

            // Find the strongest opening or hook
            const hook = lines[0] || sentences[0] || "";

            if (hook.length <= 280) {
                tweet = hook;
            } else {
                // Truncate to fit
                tweet = hook.slice(0, 275) + "...";
            }

            // Clean LinkedIn formatting
            tweet = tweet
                .replace(/^[🔹🔸▶️➡️•\-\d+.]\s*/gm, "") // remove bullet markers
                .replace(/#\w+\s*/g, "")  // remove hashtags (we'll add twitter-style ones)
                .replace(/\s+/g, " ")
                .trim();

            // Strategy 2: Thread (for long content)
            const threadTweets: string[] = [];
            let currentTweet = "";

            for (const sentence of sentences) {
                const cleaned = sentence.replace(/#\w+\s*/g, "").trim();
                if (!cleaned) continue;

                if ((currentTweet + " " + cleaned).trim().length <= 270) {
                    currentTweet = (currentTweet + " " + cleaned).trim();
                } else {
                    if (currentTweet) threadTweets.push(currentTweet);
                    currentTweet = cleaned.length > 270 ? cleaned.slice(0, 267) + "..." : cleaned;
                }
            }
            if (currentTweet) threadTweets.push(currentTweet);

            // Add hashtags
            if (hashtagsEnabled) {
                const tags = extractHashtags(text, "twitter");
                if (tags.length > 0) {
                    const tagStr = " " + tags.slice(0, 3).join(" ");
                    if (tweet.length + tagStr.length <= 280) tweet += tagStr;
                    const lastIdx = threadTweets.length - 1;
                    if (lastIdx >= 0 && threadTweets[lastIdx].length + tagStr.length <= 280) {
                        threadTweets[lastIdx] += tagStr;
                    }
                }
            }

            result.repurposed.single_tweet = { text: tweet, char_count: tweet.length };
            if (threadTweets.length > 1) {
                result.repurposed.thread = threadTweets.map((t, i) => ({
                    tweet_number: i + 1,
                    text: threadTweets.length > 1 ? `${i + 1}/${threadTweets.length} ${t}` : t,
                    char_count: t.length + (threadTweets.length > 1 ? `${i + 1}/${threadTweets.length} `.length : 0),
                }));
            }
            result.repurposed.recommendation = threadTweets.length > 3
                ? "Use the thread format — this content is too rich for a single tweet."
                : "Single tweet recommended. Thread available if you want more detail.";

        } else if (from === "twitter" && to === "linkedin") {
            // Twitter → LinkedIn: expand into professional long-form
            const tweetText = text.replace(/@\w+/g, "").replace(/https?:\/\/\S+/g, "").trim();

            // Detect tone
            const detectedTone = tone || "professional";

            let post = "";
            switch (detectedTone) {
                case "thought_leader":
                    post = `${tweetText}\n\nHere's what most people miss about this:\n\n` +
                        `The key insight is that this matters more than we think.\n\n` +
                        `What's your take on this? I'd love to hear different perspectives.`;
                    break;
                case "storytelling":
                    post = `Something caught my attention today.\n\n${tweetText}\n\n` +
                        `And it made me reflect on how this connects to the bigger picture.\n\n` +
                        `The lesson? Sometimes the simplest observations lead to the deepest insights.`;
                    break;
                case "casual":
                    post = `${tweetText}\n\nThoughts? 👇`;
                    break;
                case "professional":
                default:
                    post = `${tweetText}\n\nThis is an important point that deserves more attention.\n\n` +
                        `What are your thoughts on this?`;
                    break;
            }

            // Add LinkedIn-style hashtags
            if (hashtagsEnabled) {
                const tags = extractHashtags(text, "linkedin");
                if (tags.length > 0) {
                    post += "\n\n" + tags.slice(0, 5).join(" ");
                }
            }

            result.repurposed.post = { text: post, char_count: post.length };
            result.repurposed.tone = detectedTone;
            result.repurposed.tip = "LinkedIn posts perform best when they tell a story or share a personal insight. Consider adding 1-2 lines about your personal experience with this topic.";
        }

        return { content: [{ type: "text", text: json(result) }] };
    }
);

function extractHashtags(text: string, platform: "linkedin" | "twitter"): string[] {
    // Extract existing hashtags
    const existing = (text.match(/#\w+/g) || []).map(h => h.toLowerCase());

    // Extract key terms for new hashtags
    const words = text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 4);

    const commonWords = new Set(["about", "would", "could", "should", "their", "there", "which", "being", "these", "those", "other", "after", "before", "every", "never", "always", "really", "think", "people", "things"]);
    const keywords = words.filter(w => !commonWords.has(w));

    // Count frequency
    const freq: Record<string, number> = {};
    for (const w of keywords) freq[w] = (freq[w] || 0) + 1;

    const topWords = Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([w]) => `#${w}`);

    const allTags = [...new Set([...existing, ...topWords])];

    if (platform === "twitter") {
        return allTags.slice(0, 3); // Twitter: fewer hashtags
    }
    return allTags.slice(0, 5); // LinkedIn: more hashtags OK
}

// ── Cross-Platform Workflows ──────────────────────────────────────────────────

server.tool(
    "meeting_prep",
    `Prepare for a meeting by pulling LinkedIn profiles of all attendees from a Google Calendar event. Returns attendee names, roles, companies, headlines, and profile URLs so you're fully briefed before any call.`,
    {
        event_id: z.string().describe("Google Calendar event ID"),
        calendar_id: z.string().optional().describe("Calendar ID (default: primary)"),
        gcal_profile: z.string().optional().describe("Google Calendar credential profile"),
        linkedin_profile: z.string().optional().describe("LinkedIn credential profile"),
    },
    async ({ event_id, calendar_id, gcal_profile, linkedin_profile }) => {
        // Get event details from GCal
        const gcalAuth = await getGCalAuth(gcal_profile);
        const event = await gcal.getEvent(gcalAuth, calendar_id || "primary", event_id);

        const attendees = event.attendees || [];
        if (attendees.length === 0) {
            return { content: [{ type: "text", text: json({ event: { summary: event.summary, start: event.start, end: event.end }, attendees: [], note: "No attendees found on this event." }) }] };
        }

        const linkedinAuth = getLinkedInAuth(linkedin_profile);
        const profiles: any[] = [];

        for (const attendee of attendees) {
            const email = attendee.email || "";
            const name = attendee.displayName || email.split("@")[0];
            const profile: any = { email, name, responseStatus: attendee.responseStatus };

            // Try to find on LinkedIn by name
            if (name && name !== email) {
                try {
                    const searchResults = await linkedin.searchPeople(linkedinAuth, name, 3);
                    if (searchResults.length > 0) {
                        const best = searchResults[0];
                        profile.linkedin = {
                            name: `${best.firstName || ""} ${best.lastName || ""}`.trim(),
                            headline: best.headline,
                            location: best.location,
                            profileUrl: best.publicId ? `https://www.linkedin.com/in/${best.publicId}` : null,
                        };
                    }
                } catch {}
            }
            profiles.push(profile);
        }

        return {
            content: [{
                type: "text",
                text: json({
                    event: { summary: event.summary, start: event.start, end: event.end, location: event.location, description: event.description },
                    attendee_count: profiles.length,
                    attendees: profiles,
                }),
            }],
        };
    }
);

server.tool(
    "smart_inbox",
    `Unified notification inbox across all connected platforms. Returns a single view of what needs your attention: GitHub PRs/issues, LinkedIn messages, Slack DMs, Gmail unreads, and upcoming calendar events.`,
    {
        github_profile: z.string().optional(),
        linkedin_profile: z.string().optional(),
        gcal_profile: z.string().optional(),
        gmail_profile: z.string().optional(),
    },
    async ({ github_profile, linkedin_profile, gcal_profile, gmail_profile }) => {
        const inbox: any = { timestamp: new Date().toISOString(), sections: {} };

        // GitHub notifications
        try {
            const ghAuth = getGitHubAuth(github_profile);
            const notifications = await github.getNotifications(ghAuth, 10, false);
            inbox.sections.github = {
                count: notifications.length,
                items: notifications.map((n: any) => ({
                    reason: n.reason,
                    title: n.subject?.title,
                    type: n.subject?.type,
                    repo: n.repository?.full_name,
                    updated_at: n.updated_at,
                    url: n.subject?.url,
                })),
            };
        } catch (e: any) {
            inbox.sections.github = { error: e.message, hint: "Run: store_credential('github', 'token', 'ghp_...') or install gh CLI" };
        }

        // LinkedIn messages
        try {
            const liAuth = getLinkedInAuth(linkedin_profile);
            const convos = await linkedin.getConversations(liAuth, 5);
            const unread = (convos.conversations || []).filter((c: any) => c.unreadCount > 0);
            inbox.sections.linkedin = {
                unread_conversations: unread.length,
                items: unread.map((c: any) => ({
                    from: c.participants?.map((p: any) => p.name).join(", "),
                    preview: c.lastMessage?.slice(0, 100),
                    unread: c.unreadCount,
                })),
            };
        } catch (e: any) {
            inbox.sections.linkedin = { error: e.message };
        }

        // Google Calendar (next 5 events today)
        try {
            const calAuth = await getGCalAuth(gcal_profile);
            const now = new Date();
            const endOfDay = new Date(now);
            endOfDay.setHours(23, 59, 59, 999);
            const events = await gcal.listEvents(calAuth, "primary", {
                timeMin: now.toISOString(),
                timeMax: endOfDay.toISOString(),
                maxResults: 5,
            });
            inbox.sections.calendar = {
                remaining_today: events.length,
                items: events.map((e: any) => ({
                    summary: e.summary,
                    start: e.start?.dateTime || e.start?.date,
                    end: e.end?.dateTime || e.end?.date,
                    attendees: e.attendees?.length || 0,
                    meet_link: e.hangoutLink,
                })),
            };
        } catch (e: any) {
            inbox.sections.calendar = { error: e.message };
        }

        // Gmail unreads
        try {
            const gmailAuth = await getGmailAuth(gmail_profile);
            const result = await gmail.listMessages(gmailAuth, { query: "is:unread", maxResults: 10 });
            const messages = result.messages || [];
            inbox.sections.gmail = {
                unread_count: messages.length,
                items: messages.map((m: any) => ({
                    from: m.from,
                    subject: m.subject,
                    snippet: m.snippet,
                    date: m.date,
                })),
            };
        } catch (e: any) {
            inbox.sections.gmail = { error: e.message };
        }

        return { content: [{ type: "text", text: json(inbox) }] };
    }
);

server.tool(
    "contact_enrich",
    `Enrich a contact by searching across LinkedIn, Twitter, GitHub, and Notion. Given a name or email, returns all matching profiles with roles, bios, and links.`,
    {
        name: z.string().optional().describe("Person's name to search for"),
        email: z.string().optional().describe("Person's email to search for"),
        linkedin_profile: z.string().optional(),
    },
    async ({ name, email, linkedin_profile }) => {
        if (!name && !email) {
            return { content: [{ type: "text", text: "Provide at least a name or email to search." }] };
        }

        const searchTerm = name || (email ? email.split("@")[0].replace(/[._]/g, " ") : "");
        const result: any = { query: { name, email }, profiles: {} };

        // LinkedIn
        try {
            const liAuth = getLinkedInAuth(linkedin_profile);
            const people = await linkedin.searchPeople(liAuth, searchTerm, 5);
            result.profiles.linkedin = people.map((p: any) => ({
                name: `${p.firstName || ""} ${p.lastName || ""}`.trim(),
                headline: p.headline,
                location: p.location,
                profileUrl: p.publicId ? `https://www.linkedin.com/in/${p.publicId}` : null,
            }));
        } catch (e: any) {
            result.profiles.linkedin = { error: e.message };
        }

        // Twitter
        try {
            const twAuth = getTwitterAuth();
            const tweets = await twitter.searchTweets(twAuth, searchTerm, 5);
            const authors = new Map<string, any>();
            for (const t of tweets) {
                if (t.author && !authors.has(t.author)) {
                    authors.set(t.author, { screen_name: t.author, name: t.authorName });
                }
            }
            result.profiles.twitter = [...authors.values()].slice(0, 3);
        } catch (e: any) {
            result.profiles.twitter = { error: e.message };
        }

        // GitHub
        try {
            const ghAuth = getGitHubAuth();
            const users = await github.searchUsers(ghAuth, searchTerm, 5);
            result.profiles.github = users.map((u: any) => ({
                login: u.login,
                name: u.name,
                bio: u.bio,
                company: u.company,
                location: u.location,
                profileUrl: u.html_url,
                repos: u.public_repos,
                followers: u.followers,
            }));
        } catch (e: any) {
            result.profiles.github = { error: e.message };
        }

        // Notion (search for name in pages)
        try {
            const notionAuth = getNotionAuth();
            const pages = await notion.search(notionAuth, searchTerm, { limit: 3 });
            if (pages.length > 0) {
                result.profiles.notion = pages.map((p: any) => ({
                    title: p.title,
                    url: p.url,
                    type: p.type,
                }));
            }
        } catch {
            // Notion not connected — skip silently
        }

        return { content: [{ type: "text", text: json(result) }] };
    }
);

server.tool(
    "content_calendar",
    `Manage a cross-platform content calendar. Store draft posts, schedule them via Google Calendar, and track what's been published. Uses a 'content_calendar' collection to persist drafts.`,
    {
        action: z.enum(["create_draft", "list_drafts", "schedule", "list_scheduled", "mark_published"]).describe("Action to perform"),
        text: z.string().optional().describe("Post content (for create_draft)"),
        platform: z.enum(["linkedin", "twitter", "both"]).optional().describe("Target platform (for create_draft)"),
        draft_id: z.number().optional().describe("Draft ID (for schedule/mark_published)"),
        schedule_time: z.string().optional().describe("ISO 8601 datetime to schedule (for schedule action)"),
        gcal_profile: z.string().optional(),
    },
    async ({ action, text, platform, draft_id, schedule_time, gcal_profile }) => {
        // Ensure collection exists
        const collectionName = "content_calendar";
        try {
            await db.createCollection(collectionName, "Cross-platform content calendar drafts", [
                { name: "text", type: "text" },
                { name: "platform", type: "text" },
                { name: "status", type: "text" },
                { name: "scheduled_at", type: "text" },
                { name: "published_at", type: "text" },
                { name: "cal_event_id", type: "text" },
            ]);
        } catch {} // Already exists

        if (action === "create_draft") {
            if (!text) return { content: [{ type: "text", text: "Provide text for the draft." }] };
            const { id } = db.collectionInsert(collectionName, {
                text,
                platform: platform || "both",
                status: "draft",
                scheduled_at: "",
                published_at: "",
                cal_event_id: "",
            });
            return { content: [{ type: "text", text: json({ id, status: "draft", platform: platform || "both", text: text.slice(0, 100) + "..." }) }] };
        }

        if (action === "list_drafts") {
            const drafts = db.collectionQuery(collectionName, { where: { status: "draft" } });
            return { content: [{ type: "text", text: json(drafts) }] };
        }

        if (action === "schedule") {
            if (!draft_id || !schedule_time) return { content: [{ type: "text", text: "Provide draft_id and schedule_time." }] };
            // Create a GCal event as a reminder
            try {
                const calAuth = await getGCalAuth(gcal_profile);
                const drafts = db.collectionQuery(collectionName, { where: { id: draft_id } } as any);
                const draft = (drafts as any)[0] || drafts;
                const draftText = (draft as any)?.text || "Content post";
                const startTime = new Date(schedule_time);
                const endTime = new Date(startTime.getTime() + 15 * 60 * 1000); // 15 min reminder
                const event = await gcal.createEvent(calAuth, "primary", {
                    summary: `📝 Post: ${draftText.slice(0, 50)}...`,
                    description: `Platform: ${(draft as any)?.platform || "both"}\n\nFull text:\n${draftText}`,
                    start: startTime.toISOString(),
                    end: endTime.toISOString(),
                });
                db.collectionUpdate(collectionName, draft_id, { status: "scheduled", scheduled_at: schedule_time, cal_event_id: event.id || "" });
                return { content: [{ type: "text", text: json({ draft_id, status: "scheduled", scheduled_at: schedule_time, cal_event_id: event.id }) }] };
            } catch (e: any) {
                // Schedule without GCal
                db.collectionUpdate(collectionName, draft_id, { status: "scheduled", scheduled_at: schedule_time });
                return { content: [{ type: "text", text: json({ draft_id, status: "scheduled", scheduled_at: schedule_time, note: `GCal: ${e.message}` }) }] };
            }
        }

        if (action === "list_scheduled") {
            const scheduled = db.collectionQuery(collectionName, { where: { status: "scheduled" } });
            return { content: [{ type: "text", text: json(scheduled) }] };
        }

        if (action === "mark_published") {
            if (!draft_id) return { content: [{ type: "text", text: "Provide draft_id." }] };
            db.collectionUpdate(collectionName, draft_id, { status: "published", published_at: new Date().toISOString() });
            return { content: [{ type: "text", text: json({ draft_id, status: "published", published_at: new Date().toISOString() }) }] };
        }

        return { content: [{ type: "text", text: "Unknown action." }] };
    }
);

server.tool(
    "pr_digest",
    `Get a digest of your GitHub activity: open PRs needing review, your PRs with pending reviews, failing CI, and recent issues. Optionally post a summary to a Slack channel.`,
    {
        github_profile: z.string().optional(),
        slack_profile: z.string().optional(),
        slack_channel: z.string().optional().describe("Slack channel to post digest to (optional)"),
        repos: z.array(z.string()).optional().describe("List of owner/repo to check (default: your recent repos)"),
    },
    async ({ github_profile, slack_profile, slack_channel, repos }) => {
        const ghAuth = getGitHubAuth(github_profile);
        const digest: any = { timestamp: new Date().toISOString(), sections: {} };

        // Determine repos to check
        let repoList = repos || [];
        if (repoList.length === 0) {
            try {
                const myRepos = await github.listMyRepos(ghAuth, 10, "pushed");
                repoList = myRepos.map((r: any) => r.name);
            } catch {}
        }

        // GitHub notifications (PR reviews, mentions)
        try {
            const notifications = await github.getNotifications(ghAuth, 20, false);
            const prNotifications = notifications.filter((n: any) => n.subject?.type === "PullRequest");
            digest.sections.review_requests = {
                count: prNotifications.length,
                items: prNotifications.slice(0, 10).map((n: any) => ({
                    title: n.subject?.title,
                    repo: n.repository?.full_name,
                    reason: n.reason,
                    updated_at: n.updated_at,
                })),
            };
        } catch (e: any) {
            digest.sections.review_requests = { error: e.message };
        }

        // Open PRs across repos
        const allPRs: any[] = [];
        for (const repo of repoList.slice(0, 5)) {
            const [owner, name] = repo.includes("/") ? repo.split("/") : ["", repo];
            try {
                const ownerName = owner || (await github.getAuthenticatedUser(ghAuth)).login;
                const prs = await github.listPRs(ghAuth, ownerName, name, { state: "open", count: 10 });
                for (const pr of prs) {
                    allPRs.push({
                        repo: `${ownerName}/${name}`,
                        number: pr.number,
                        title: pr.title,
                        author: pr.user?.login,
                        created_at: pr.created_at,
                        draft: pr.draft,
                        reviews: pr.requested_reviewers?.length || 0,
                    });
                }
            } catch {}
        }
        digest.sections.open_prs = { count: allPRs.length, items: allPRs };

        // Recent workflow runs (CI status)
        const failedRuns: any[] = [];
        for (const repo of repoList.slice(0, 5)) {
            const [owner, name] = repo.includes("/") ? repo.split("/") : ["", repo];
            try {
                const ownerName = owner || (await github.getAuthenticatedUser(ghAuth)).login;
                const runs = await github.listWorkflowRuns(ghAuth, ownerName, name, 5);
                const failed = runs.filter((r: any) => r.conclusion === "failure");
                for (const r of failed) {
                    failedRuns.push({
                        repo: `${ownerName}/${name}`,
                        workflow: r.name,
                        branch: r.head_branch,
                        status: r.conclusion,
                        url: r.html_url,
                    });
                }
            } catch {}
        }
        digest.sections.failed_ci = { count: failedRuns.length, items: failedRuns };

        // Post to Slack if requested
        if (slack_channel) {
            try {
                const slackAuth = getSlackAuth(slack_profile);
                const lines = [`*🔔 PR Digest — ${new Date().toLocaleDateString()}*`];
                if (allPRs.length > 0) {
                    lines.push(`\n*Open PRs (${allPRs.length}):*`);
                    for (const pr of allPRs.slice(0, 5)) {
                        lines.push(`• ${pr.repo}#${pr.number}: ${pr.title} (by ${pr.author})`);
                    }
                }
                if (failedRuns.length > 0) {
                    lines.push(`\n*❌ Failed CI (${failedRuns.length}):*`);
                    for (const r of failedRuns.slice(0, 5)) {
                        lines.push(`• ${r.repo}: ${r.workflow} on ${r.branch}`);
                    }
                }
                await slack.postMessage(slackAuth, slack_channel, lines.join("\n"));
                digest.slack_posted = true;
            } catch (e: any) {
                digest.slack_posted = false;
                digest.slack_error = e.message;
            }
        }

        return { content: [{ type: "text", text: json(digest) }] };
    }
);

// ── Dynamic Tools (AI creates its own integrations) ──────────────────────────

/**
 * Register a custom tool on the running MCP server.
 * The code runs as an async function with these helpers injected:
 *   - params: the tool's input parameters
 *   - fetch: global fetch (for direct HTTP calls)
 *   - credentials(service): get stored credentials for a service
 *   - browserFetch(url, opts): make authenticated request from browser context
 *   - store(service, key, value): store a credential
 *   - query(collection, opts): query a collection
 *   - insert(collection, data): insert into a collection
 */
// Track dynamic tool handles for update/remove
const dynamicToolHandles = new Map<string, { remove: () => void; update: (u: any) => void }>();

function buildToolCallback(code: string) {
    return async (params: any) => {
        try {
            const helpers = {
                credentials: (service: string) => db.getCredentials(service),
                browserFetch: async (url: string, opts?: any) => {
                    if (!isBridgeConnected()) throw new Error("Browser not connected");
                    return browserCommand("browser_fetch", { url, ...opts, credentials: "include" });
                },
                store: (service: string, key: string, value: string) => db.storeCredential(service, key, value),
                query: (collection: string, opts?: any) => db.collectionQuery(collection, opts || {}),
                insert: (collection: string, data: any) => db.collectionInsert(collection, data),
            };

            const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
            const fn = new AsyncFunction("params", "helpers", "fetch", code);
            const result = await fn(params, helpers, globalThis.fetch);

            const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
            return { content: [{ type: "text" as const, text }] };
        } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
        }
    };
}

function buildZodShape(paramsSchema: Record<string, string>) {
    const zodShape: Record<string, any> = {};
    for (const [param, type] of Object.entries(paramsSchema)) {
        const optional = type.endsWith("?");
        const baseType = optional ? type.slice(0, -1) : type;
        let zType: any;
        switch (baseType) {
            case "number": zType = z.number(); break;
            case "boolean": zType = z.boolean(); break;
            case "array": zType = z.array(z.any()); break;
            case "object": zType = z.record(z.string(), z.any()); break;
            default: zType = z.string(); break;
        }
        zodShape[param] = optional ? zType.optional() : zType;
    }
    return zodShape;
}

function registerDynamicTool(name: string, description: string, paramsSchema: Record<string, string>, code: string) {
    // Remove existing registration if updating
    const existing = dynamicToolHandles.get(name);
    if (existing) {
        existing.remove();
        dynamicToolHandles.delete(name);
    }

    const handle = server.tool(name, description, buildZodShape(paramsSchema), buildToolCallback(code));
    dynamicToolHandles.set(name, handle);
}

server.tool(
    "create_tool",
    `Create a new MCP tool that persists across restarts. You write the implementation as JavaScript.

Your code runs as an async function with these available:
  params        - the tool's input (defined by params_schema)
  helpers.credentials(service)   - get stored auth tokens for a service
  helpers.browserFetch(url, opts) - HTTP request from browser (carries cookies)
  helpers.store(service, key, val) - store a credential
  helpers.query(collection, opts) - query a collection
  helpers.insert(collection, data) - insert into collection
  fetch         - standard fetch for direct HTTP calls

Example — creating a Notion integration:
  name: "notion_get_pages"
  description: "Get all pages from Notion workspace"
  params_schema: { "limit": "number?" }
  code: |
    const creds = helpers.credentials("notion");
    if (!creds.token_v2) throw new Error("No Notion token. Run extract_auth('notion') first.");
    const res = await fetch("https://www.notion.so/api/v3/getSpaces", {
      method: "POST",
      headers: { "Cookie": "token_v2=" + creds.token_v2, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    return await res.json();`,
    {
        name: z.string().describe("Tool name (lowercase, underscores, e.g. 'notion_get_pages')"),
        description: z.string().describe("What the tool does"),
        params_schema: z.record(z.string(), z.string()).describe("Parameter definitions: { name: 'type' }. Types: string, number, boolean, array, object. Append ? for optional."),
        code: z.string().describe("JavaScript async function body. Has access to params, helpers, fetch."),
        service: z.string().optional().describe("Service name this tool belongs to (for grouping)"),
    },
    async ({ name, description, params_schema, code, service }) => {
        // Save to DB
        db.saveCustomTool(name, description, params_schema, code, service);

        // Register on running server
        registerDynamicTool(name, description, params_schema, code);

        // Notify Claude Desktop that new tools are available
        await server.server.sendToolListChanged();

        return { content: [{ type: "text", text: `Tool "${name}" created and registered. Available immediately.` }] };
    }
);

server.tool(
    "update_tool",
    "Update an existing custom tool's description, parameters, or code.",
    {
        name: z.string().describe("Tool name to update"),
        description: z.string().optional(),
        params_schema: z.record(z.string(), z.string()).optional(),
        code: z.string().optional(),
    },
    async ({ name, description, params_schema, code }) => {
        const existing = db.getCustomTool(name);
        if (!existing) return { content: [{ type: "text", text: `Tool "${name}" not found.` }] };

        const newDesc = description || existing.description;
        const newSchema = params_schema || JSON.parse(existing.params_schema);
        const newCode = code || existing.code;

        db.saveCustomTool(name, newDesc, newSchema, newCode, existing.service || undefined);
        registerDynamicTool(name, newDesc, newSchema, newCode);
        await server.server.sendToolListChanged();

        return { content: [{ type: "text", text: `Tool "${name}" updated. Changes active immediately.` }] };
    }
);

// ── Universal API Discovery ──────────────────────────────────────────────────

server.tool(
    "discover_api",
    `Discover a website's internal API by navigating to it and capturing network requests. This automates the API discovery workflow:
1. Extracts auth tokens from the target site
2. Starts network capture and navigates to the specified URL
3. Waits for API requests to load
4. Returns all captured API endpoints with their methods, URLs, status codes, and headers
5. Suggests which endpoints are useful and how to call them

Use this as the first step when building a new integration for ANY website.`,
    {
        url: z.string().describe("The URL to navigate to and discover APIs from (e.g. 'https://app.example.com/dashboard')"),
        service: z.string().optional().describe("Service name for auth extraction (e.g. 'example.com'). Auto-detected from URL if omitted."),
        filters: z.array(z.string()).optional().describe("URL substrings to capture (e.g. ['api.', 'graphql']). Empty captures all requests."),
        wait_seconds: z.number().optional().describe("How long to wait for API requests (default: 5s, max: 15s)"),
    },
    async ({ url, service, filters, wait_seconds }) => {
        if (!isBridgeConnected()) {
            return { content: [{ type: "text", text: "Browser extension not connected. Install the Neo Bridge extension and make sure Chrome is running." }] };
        }

        const results: string[] = [];
        const domain = service || new URL(url).hostname;

        // Step 1: Extract auth
        results.push(`## Step 1: Extracting auth from ${domain}...`);
        try {
            const authResult = await browserCommand("extract_auth", { service: domain });
            const storageKey = domain;
            const creds: Record<string, string> = {};
            for (const [key, value] of Object.entries(authResult)) {
                if (key === "service" || !value || typeof value !== "string") continue;
                creds[key] = value as string;
                try { db.storeCredential(storageKey, key, value as string); } catch {}
            }
            if (Array.isArray(authResult.cookies) && authResult.cookies.length > 0) {
                const cookieHeader = authResult.cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
                creds._cookies = cookieHeader;
                try { db.storeCredential(storageKey, "_cookies", cookieHeader); } catch {}
            }
            storeAuthInMemory(storageKey, creds);
            const tokenKeys = Object.keys(creds).filter(k => !k.startsWith("_"));
            results.push(`✅ Auth extracted. Tokens: ${tokenKeys.join(", ") || "cookies only"}`);
        } catch (err: any) {
            results.push(`⚠️ Auth extraction failed: ${err.message}. Continuing anyway...`);
        }

        // Step 2: Start network capture and navigate
        results.push(`\n## Step 2: Capturing network requests from ${url}...`);
        await browserCommand("network_start_capture", { filters: filters || [] });
        await browserCommand("navigate", { url });

        // Step 3: Wait for requests
        const waitMs = Math.min((wait_seconds || 5), 15) * 1000;
        await new Promise(r => setTimeout(r, waitMs));

        // Step 4: Collect captured requests
        const captureData = await browserCommand("network_list", { filter: undefined, limit: 200 });
        const requests = captureData?.requests || [];

        // Stop capture
        await browserCommand("network_stop_capture");

        if (requests.length === 0) {
            results.push("❌ No network requests captured. The page may not have loaded, or try adding more specific filters.");
            return { content: [{ type: "text", text: results.join("\n") }] };
        }

        results.push(`✅ Captured ${requests.length} requests.\n`);

        // Step 5: Categorize requests
        const apiRequests = requests.filter((r: any) => {
            const u = (r.url || "").toLowerCase();
            const isAsset = u.endsWith(".js") || u.endsWith(".css") || u.endsWith(".png") || u.endsWith(".jpg") ||
                u.endsWith(".svg") || u.endsWith(".woff2") || u.endsWith(".woff") || u.endsWith(".ico") ||
                u.includes("/static/") || u.includes("/assets/") || u.includes("/_next/static/");
            return !isAsset;
        });

        const dataRequests = apiRequests.filter((r: any) => {
            const u = (r.url || "").toLowerCase();
            return u.includes("api") || u.includes("graphql") || u.includes("/v1/") || u.includes("/v2/") ||
                u.includes("/v3/") || u.includes("json") || u.includes("rpc") || u.includes("query") ||
                (r.method && r.method !== "GET");
        });

        results.push("## API Endpoints Discovered\n");
        results.push("### High-confidence API calls:");
        if (dataRequests.length > 0) {
            for (const r of dataRequests.slice(0, 30)) {
                results.push(`  [${r.id}] ${r.method || "GET"} ${r.status || "?"} ${r.url}`);
            }
        } else {
            results.push("  (none detected — check 'Other requests' below)");
        }

        const otherRequests = apiRequests.filter((r: any) => !dataRequests.includes(r));
        if (otherRequests.length > 0) {
            results.push(`\n### Other requests (${otherRequests.length}):`);
            for (const r of otherRequests.slice(0, 20)) {
                results.push(`  [${r.id}] ${r.method || "GET"} ${r.status || "?"} ${r.url}`);
            }
        }

        results.push(`\n## Next Steps`);
        results.push(`1. Use network_request_detail(id) to inspect any interesting request's full headers and response`);
        results.push(`2. Use authenticated_fetch() to replay the request and verify it works`);
        results.push(`3. Use create_tool() to save it as a permanent tool`);
        results.push(`\nAuth tokens stored under service "${domain}" — use helpers.credentials("${domain}") in create_tool code.`);

        return { content: [{ type: "text", text: results.join("\n") }] };
    }
);

// ── Web Scrape (structured data extraction) ──────────────────────────────────

server.tool(
    "web_scrape",
    `Extract structured data from any URL. Returns clean, parsed content instead of raw HTML. Extracts: page title, meta description, main text content, all links, tables (as arrays), images, OpenGraph/meta tags, and JSON-LD structured data. Use this instead of authenticated_fetch when you need usable data from a page.`,
    {
        url: z.string().describe("URL to scrape"),
        extract: z.array(z.enum(["text", "links", "tables", "images", "meta", "structured_data", "all"])).optional()
            .describe("What to extract (default: all)"),
        selector: z.string().optional().describe("CSS selector to scope extraction (e.g. 'article', '.content', '#main')"),
    },
    async ({ url, extract, selector }) => {
        if (!isBridgeConnected()) {
            return { content: [{ type: "text", text: "Browser extension not connected." }] };
        }

        // Navigate and get page content via browser
        await browserCommand("navigate", { url });
        await new Promise(r => setTimeout(r, 3000)); // Wait for page load

        const extractAll = !extract || extract.includes("all");
        const wants = (t: string) => extractAll || extract?.includes(t as any);

        // Execute extraction script in the browser
        const script = `
        (function() {
            const scope = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document'} || document;
            const result = {};

            // Title & meta
            result.url = window.location.href;
            result.title = document.title || '';

            ${wants("meta") || wants("text") ? `
            // Meta tags
            const metaDesc = document.querySelector('meta[name="description"]');
            result.meta = {
                description: metaDesc ? metaDesc.content : '',
                og: {},
            };
            document.querySelectorAll('meta[property^="og:"]').forEach(m => {
                const key = m.getAttribute('property').replace('og:', '');
                result.meta.og[key] = m.content;
            });
            document.querySelectorAll('meta[name^="twitter:"]').forEach(m => {
                const key = m.getAttribute('name').replace('twitter:', '');
                result.meta['twitter_' + key] = m.content;
            });
            const canonical = document.querySelector('link[rel="canonical"]');
            if (canonical) result.meta.canonical = canonical.href;
            ` : ''}

            ${wants("text") ? `
            // Main text content — try article/main first, fall back to body
            const contentEl = scope.querySelector('article') || scope.querySelector('[role="main"]') || scope.querySelector('main') || scope.querySelector('.content') || scope.querySelector('#content') || scope;
            // Remove scripts, styles, nav, footer, header, ads
            const clone = contentEl.cloneNode(true);
            clone.querySelectorAll('script, style, nav, footer, header, aside, .ad, .ads, .advertisement, [role="navigation"], [role="banner"], [role="contentinfo"]').forEach(el => el.remove());
            const textContent = clone.innerText || clone.textContent || '';
            // Clean up whitespace
            result.text = textContent.replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]+/g, ' ').trim().slice(0, 50000);
            result.text_length = result.text.length;
            result.word_count = result.text.split(/\\s+/).filter(w => w).length;
            ` : ''}

            ${wants("links") ? `
            // Links
            const links = [];
            scope.querySelectorAll('a[href]').forEach(a => {
                const href = a.href;
                const text = (a.innerText || '').trim().slice(0, 200);
                if (href && !href.startsWith('javascript:') && text) {
                    links.push({ text, href });
                }
            });
            // Deduplicate by href
            const seen = new Set();
            result.links = links.filter(l => { if (seen.has(l.href)) return false; seen.add(l.href); return true; }).slice(0, 200);
            result.link_count = result.links.length;
            ` : ''}

            ${wants("tables") ? `
            // Tables
            result.tables = [];
            scope.querySelectorAll('table').forEach((table, idx) => {
                const rows = [];
                table.querySelectorAll('tr').forEach(tr => {
                    const cells = [];
                    tr.querySelectorAll('th, td').forEach(td => {
                        cells.push((td.innerText || '').trim());
                    });
                    if (cells.length > 0) rows.push(cells);
                });
                if (rows.length > 0) {
                    result.tables.push({ index: idx, headers: rows[0], rows: rows.slice(1, 100) });
                }
            });
            ` : ''}

            ${wants("images") ? `
            // Images
            result.images = [];
            scope.querySelectorAll('img[src]').forEach(img => {
                const src = img.src;
                const alt = img.alt || '';
                const w = img.naturalWidth || img.width;
                const h = img.naturalHeight || img.height;
                if (src && w > 50 && h > 50) { // Skip tiny icons
                    result.images.push({ src, alt, width: w, height: h });
                }
            });
            result.images = result.images.slice(0, 50);
            ` : ''}

            ${wants("structured_data") ? `
            // JSON-LD structured data
            result.structured_data = [];
            document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
                try { result.structured_data.push(JSON.parse(s.textContent)); } catch {}
            });
            ` : ''}

            return result;
        })()
        `;

        try {
            const data = await browserCommand("execute_script", { code: script });
            return { content: [{ type: "text", text: json(data) }] };
        } catch (err: any) {
            // Fallback: try getting page text via simpler method
            try {
                const textScript = `({ url: window.location.href, title: document.title, text: document.body.innerText.slice(0, 30000) })`;
                const fallback = await browserCommand("execute_script", { code: textScript });
                return { content: [{ type: "text", text: json({ ...fallback, note: "Partial extraction (full script failed)" }) }] };
            } catch {
                return { content: [{ type: "text", text: `Scrape failed: ${err.message}` }] };
            }
        }
    }
);

// ── Diff Monitor (watch anything for changes) ────────────────────────────────

server.tool(
    "diff_monitor",
    `Monitor any URL or API endpoint for changes. Stores snapshots in a collection, compares against the previous snapshot, and reports what changed. Use for: price tracking, job posting changes, competitor monitoring, stock availability, or any "tell me when X changes" request.`,
    {
        action: z.enum(["check", "list", "history", "remove"]).describe("check: take snapshot & compare, list: show all monitors, history: show snapshots for a monitor, remove: stop monitoring"),
        url: z.string().optional().describe("URL to monitor (for check action)"),
        name: z.string().optional().describe("Friendly name for this monitor (for check/remove/history)"),
        selector: z.string().optional().describe("CSS selector to monitor specific content (for check)"),
        extract: z.enum(["text", "html", "json"]).optional().describe("What to extract: text (default), html, or json (for API endpoints)"),
    },
    async ({ action, url, name, selector, extract }) => {
        const COLLECTION = "diff_monitor";

        // Ensure collection exists
        try {
            db.createCollection(COLLECTION, "Page change monitoring snapshots", [
                { name: "monitor_name", type: "text" },
                { name: "url", type: "text" },
                { name: "selector", type: "text" },
                { name: "extract_type", type: "text" },
                { name: "content_hash", type: "text" },
                { name: "content", type: "text" },
                { name: "checked_at", type: "text" },
                { name: "changed", type: "boolean" },
                { name: "diff_summary", type: "text" },
            ]);
        } catch {} // Already exists

        if (action === "list") {
            // Get unique monitors
            const all = db.collectionQuery(COLLECTION, { orderBy: "checked_at DESC", limit: 200 }) as any[];
            const monitors = new Map<string, any>();
            for (const row of all) {
                if (!monitors.has(row.monitor_name)) {
                    monitors.set(row.monitor_name, {
                        name: row.monitor_name,
                        url: row.url,
                        selector: row.selector || null,
                        last_checked: row.checked_at,
                        last_changed: row.changed ? row.checked_at : null,
                        snapshot_count: 0,
                    });
                }
                const m = monitors.get(row.monitor_name)!;
                m.snapshot_count++;
                if (row.changed && (!m.last_changed || row.checked_at > m.last_changed)) {
                    m.last_changed = row.checked_at;
                }
            }
            return { content: [{ type: "text", text: json([...monitors.values()]) }] };
        }

        if (action === "history") {
            if (!name) return { content: [{ type: "text", text: "Provide a monitor name." }] };
            const snapshots = db.collectionQuery(COLLECTION, { where: { monitor_name: name }, orderBy: "checked_at DESC", limit: 20 }) as any[];
            return { content: [{ type: "text", text: json(snapshots.map(s => ({ checked_at: s.checked_at, changed: s.changed, diff_summary: s.diff_summary, content_preview: (s.content || "").slice(0, 200) }))) }] };
        }

        if (action === "remove") {
            if (!name) return { content: [{ type: "text", text: "Provide a monitor name to remove." }] };
            const rows = db.collectionQuery(COLLECTION, { where: { monitor_name: name } }) as any[];
            let removed = 0;
            for (const row of rows) {
                try { db.collectionDelete(COLLECTION, row.id); removed++; } catch {}
            }
            return { content: [{ type: "text", text: `Removed monitor "${name}" (${removed} snapshots deleted).` }] };
        }

        // action === "check"
        if (!url) return { content: [{ type: "text", text: "Provide a URL to monitor." }] };
        const monitorName = name || new URL(url).hostname + new URL(url).pathname;
        const extractType = extract || "text";

        // Fetch current content
        let currentContent = "";
        try {
            if (extractType === "json") {
                // API endpoint — use authenticated_fetch
                const result = await browserCommand("browser_fetch", { url, method: "GET", credentials: "include" });
                currentContent = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
            } else {
                // Web page — navigate and extract
                await browserCommand("navigate", { url });
                await new Promise(r => setTimeout(r, 3000));

                const script = selector
                    ? `(document.querySelector(${JSON.stringify(selector)}) || document.body).${extractType === "html" ? "innerHTML" : "innerText"}`
                    : `document.body.${extractType === "html" ? "innerHTML" : "innerText"}`;
                currentContent = await browserCommand("execute_script", { code: script }) || "";
                if (typeof currentContent !== "string") currentContent = JSON.stringify(currentContent);
            }
        } catch (err: any) {
            return { content: [{ type: "text", text: `Failed to fetch ${url}: ${err.message}` }] };
        }

        // Simple content hash
        let hash = 0;
        for (let i = 0; i < currentContent.length; i++) {
            hash = ((hash << 5) - hash + currentContent.charCodeAt(i)) | 0;
        }
        const contentHash = hash.toString(36);

        // Get previous snapshot
        const previous = (db.collectionQuery(COLLECTION, {
            where: { monitor_name: monitorName },
            orderBy: "checked_at DESC",
            limit: 1,
        }) as any[])[0];

        let changed = true;
        let diffSummary = "First snapshot — baseline recorded.";

        if (previous) {
            changed = previous.content_hash !== contentHash;
            if (changed) {
                // Generate diff summary
                const prevLines = (previous.content || "").split("\\n");
                const currLines = currentContent.split("\\n");
                const added = currLines.filter((l: string) => !prevLines.includes(l)).slice(0, 10);
                const removed = prevLines.filter((l: string) => !currLines.includes(l)).slice(0, 10);
                const parts: string[] = [];
                if (added.length > 0) parts.push(`Added (${added.length} lines): ${added.map((l: string) => l.slice(0, 80)).join(" | ")}`);
                if (removed.length > 0) parts.push(`Removed (${removed.length} lines): ${removed.map((l: string) => l.slice(0, 80)).join(" | ")}`);
                diffSummary = parts.join("\\n") || "Content changed (binary diff)";
            } else {
                diffSummary = "No changes detected.";
            }
        }

        // Store snapshot (truncate content to 50KB to avoid DB bloat)
        db.collectionInsert(COLLECTION, {
            monitor_name: monitorName,
            url,
            selector: selector || "",
            extract_type: extractType,
            content_hash: contentHash,
            content: currentContent.slice(0, 50000),
            checked_at: new Date().toISOString(),
            changed,
            diff_summary: diffSummary,
        });

        return {
            content: [{
                type: "text",
                text: json({
                    monitor: monitorName,
                    url,
                    changed,
                    diff_summary: diffSummary,
                    content_preview: currentContent.slice(0, 500),
                    checked_at: new Date().toISOString(),
                    previous_check: previous?.checked_at || null,
                }),
            }],
        };
    }
);

server.tool(
    "list_custom_tools",
    "List all custom tools that have been created.",
    {},
    async () => {
        const tools = db.getCustomTools();
        if (tools.length === 0) return { content: [{ type: "text", text: "No custom tools created yet." }] };
        const lines = tools.map((t: any) => `${t.name} (${t.service || "general"}) — ${t.description}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
);

server.tool(
    "get_tool_code",
    "View the implementation code of a custom tool.",
    { name: z.string() },
    async ({ name }) => {
        const tool = db.getCustomTool(name);
        if (!tool) return { content: [{ type: "text", text: `Tool "${name}" not found.` }] };
        return { content: [{ type: "text", text: `// ${tool.name}: ${tool.description}\n// params: ${tool.params_schema}\n\n${tool.code}` }] };
    }
);

server.tool(
    "delete_tool",
    "Delete a custom tool.",
    { name: z.string() },
    async ({ name }) => {
        const deleted = db.deleteCustomTool(name);
        if (deleted) await server.server.sendToolListChanged();
        return { content: [{ type: "text", text: deleted ? `Deleted "${name}".` : `Tool "${name}" not found.` }] };
    }
);

// ── Start ────────────────────────────────────────────────────────────────────

const httpOnly = process.env.NEO_TRANSPORT === "http" || process.argv.includes("--http-only");
const httpPort = parseInt(process.env.NEO_HTTP_PORT || "3100", 10);

async function main() {
    // Start WebSocket server for browser extension
    await startBridge();

    // Wire browser command into integrations so they route through the extension
    linkedin.setBrowserCommand(browserCommand);
    twitter.setBrowserCommand(browserCommand);
    github.setBrowserCommand(browserCommand);
    notion.setBrowserCommand(browserCommand);
    discord.setBrowserCommand(browserCommand);

    // Load and register all saved custom tools (graceful — db may fail on Linux VM)
    try {
        const customTools = db.getCustomTools();
        for (const tool of customTools) {
            try {
                const schema = JSON.parse(tool.params_schema);
                registerDynamicTool(tool.name, tool.description, schema, tool.code);
            } catch (err: any) {
                console.error(`Failed to load custom tool "${tool.name}": ${err.message}`);
            }
        }
    } catch (err: any) {
        console.error(`[neo-mcp] Database unavailable (${err.message.split("\n")[0]}). Collections and custom tools disabled.`);
    }

    // ── HTTP Streamable transport (always on — for Cowork/Windows/remote) ──
    const app = express();
    const transports = new Map<string, StreamableHTTPServerTransport>();

    app.post("/mcp", async (req, res) => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports.has(sessionId)) {
            transport = transports.get(sessionId)!;
        } else if (!sessionId) {
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
            });
            transport.onclose = () => {
                if (transport.sessionId) transports.delete(transport.sessionId);
            };
            const sessionServer = new McpServer(
                { name: "neo", version: "1.0.0" },
                { instructions: NEO_INSTRUCTIONS },
            );
            registerAllTools(sessionServer);
            await sessionServer.connect(transport);
            // Note: sessionId is generated during handleRequest, stored below
        } else {
            res.status(400).json({ error: "Invalid or expired session" });
            return;
        }

        await transport.handleRequest(req, res, req.body);

        // Store new transports in the map AFTER handleRequest generates the session ID
        if (transport.sessionId && !transports.has(transport.sessionId)) {
            transports.set(transport.sessionId, transport);
        }
    });

    app.get("/mcp", async (req, res) => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (!sessionId || !transports.has(sessionId)) {
            res.status(400).json({ error: "Invalid or missing session ID" });
            return;
        }
        await transports.get(sessionId)!.handleRequest(req, res);
    });

    app.delete("/mcp", async (req, res) => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (sessionId && transports.has(sessionId)) {
            await transports.get(sessionId)!.close();
            transports.delete(sessionId);
        }
        res.status(200).end();
    });

    // ── Gmail OAuth ──────────────────────────────────────────────────────
    app.get("/gmail/auth", (req: any, res: any) => {
        const profile = req.query.profile || undefined;
        const redirectUri = `http://localhost:${httpPort}/gmail/callback`;
        const url = gmail.getOAuthUrl(redirectUri, profile);
        res.redirect(url);
    });

    app.get("/gmail/callback", async (req: any, res: any) => {
        const code = req.query.code as string;
        const profile = (req.query.state as string) || "default";
        if (!code) { res.status(400).send("Missing authorization code."); return; }
        try {
            const redirectUri = `http://localhost:${httpPort}/gmail/callback`;
            const tokens = await gmail.exchangeCode(code, redirectUri);
            const storageKey = profileKey("gmail", profile === "default" ? undefined : profile);
            const creds: Record<string, string> = { refresh_token: tokens.refresh_token };
            try { db.storeCredential(storageKey, "refresh_token", tokens.refresh_token); } catch {}
            storeAuthInMemory(storageKey, creds);
            // Get the email address for confirmation
            let email = "";
            try {
                const auth = { access_token: tokens.access_token };
                const p = await gmail.getProfile(auth);
                email = p.email;
                try { db.storeCredential(storageKey, "email", email); } catch {}
                storeAuthInMemory(storageKey, { ...creds, email });
            } catch {}
            const label = profile !== "default" ? ` (profile: ${profile})` : "";
            res.send(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#111;color:#fff"><div style="text-align:center"><h1>Gmail Connected &#x2705;</h1><p style="color:#aaa">${email}${label}</p><p style="color:#666">You can close this tab.</p></div></body></html>`);
        } catch (err: any) {
            res.status(500).send(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#111;color:#fff"><div style="text-align:center"><h1>Auth Failed</h1><p style="color:#f66">${err.message}</p></div></body></html>`);
        }
    });

    // ── Google Calendar OAuth ───────────────────────────────────────────────
    app.get("/gcal/auth", (req: any, res: any) => {
        const profile = req.query.profile || undefined;
        const redirectUri = `http://localhost:${httpPort}/gcal/callback`;
        const url = gcal.getOAuthUrl(redirectUri, profile);
        res.redirect(url);
    });

    app.get("/gcal/callback", async (req: any, res: any) => {
        const code = req.query.code as string;
        const profile = (req.query.state as string) || "default";
        if (!code) { res.status(400).send("Missing authorization code."); return; }
        try {
            const redirectUri = `http://localhost:${httpPort}/gcal/callback`;
            const tokens = await gcal.exchangeCode(code, redirectUri);
            const storageKey = profileKey("gcal", profile === "default" ? undefined : profile);
            const creds: Record<string, string> = { refresh_token: tokens.refresh_token };
            try { db.storeCredential(storageKey, "refresh_token", tokens.refresh_token); } catch {}
            storeAuthInMemory(storageKey, creds);
            const label = profile !== "default" ? ` (profile: ${profile})` : "";
            res.send(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#111;color:#fff"><div style="text-align:center"><h1>Google Calendar Connected &#x2705;</h1><p style="color:#aaa">${label}</p><p style="color:#666">You can close this tab.</p></div></body></html>`);
        } catch (err: any) {
            res.status(500).send(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#111;color:#fff"><div style="text-align:center"><h1>Auth Failed</h1><p style="color:#f66">${err.message}</p></div></body></html>`);
        }
    });

    // ── Google Drive OAuth ────────────────────────────────────────────────
    app.get("/gdrive/auth", (req: any, res: any) => {
        const profile = req.query.profile || undefined;
        const redirectUri = `http://localhost:${httpPort}/gdrive/callback`;
        const url = gdrive.getOAuthUrl(redirectUri, profile);
        res.redirect(url);
    });

    app.get("/gdrive/callback", async (req: any, res: any) => {
        const code = req.query.code as string;
        const profile = (req.query.state as string) || "default";
        if (!code) { res.status(400).send("Missing authorization code."); return; }
        try {
            const redirectUri = `http://localhost:${httpPort}/gdrive/callback`;
            const tokens = await gdrive.exchangeCode(code, redirectUri);
            const storageKey = profileKey("gdrive", profile === "default" ? undefined : profile);
            const creds: Record<string, string> = { refresh_token: tokens.refresh_token };
            try { db.storeCredential(storageKey, "refresh_token", tokens.refresh_token); } catch {}
            storeAuthInMemory(storageKey, creds);
            const label = profile !== "default" ? ` (profile: ${profile})` : "";
            res.send(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#111;color:#fff"><div style="text-align:center"><h1>Google Drive Connected &#x2705;</h1><p style="color:#aaa">${label}</p><p style="color:#666">You can close this tab.</p></div></body></html>`);
        } catch (err: any) {
            res.status(500).send(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#111;color:#fff"><div style="text-align:center"><h1>Auth Failed</h1><p style="color:#f66">${err.message}</p></div></body></html>`);
        }
    });

    // ── WhatsApp QR page ──────────────────────────────────────────────────
    app.get("/whatsapp-qr", async (req, res) => {
        const wa = await import("./integrations/whatsapp.js");
        const { state, qr } = wa.getConnectionState();
        const QRCode = (await import("qrcode")).default;
        let body: string;
        if (state === "connected") {
            body = `<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#111;color:#fff"><h1>WhatsApp Connected &#x2705;</h1></body></html>`;
        } else if (qr) {
            const dataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8, width: 300 });
            body = `<html><head><meta http-equiv="refresh" content="5"></head><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#111;color:#fff"><h2>Scan with WhatsApp</h2><p style="color:#aaa">Linked Devices &rarr; Link a Device</p><div style="background:white;padding:24px;border-radius:16px"><img src="${dataUrl}" width="300" height="300" style="display:block"></div><p style="color:#666;margin-top:16px">Auto-refreshing every 5s...</p></body></html>`;
        } else {
            body = `<html><head><meta http-equiv="refresh" content="3"></head><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#111;color:#fff"><h2>Connecting to WhatsApp... waiting for QR code</h2></body></html>`;
        }
        res.setHeader("Content-Type", "text/html");
        res.send(body);
    });

    app.listen(httpPort, "127.0.0.1", () => {
        console.error(`[neo-mcp] HTTP transport listening on http://127.0.0.1:${httpPort}/mcp`);
    });

    // ── Stdio transport (for Claude Desktop — skip if HTTP-only mode) ────
    if (!httpOnly) {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error(`[neo-mcp] Stdio transport connected (Claude Desktop)`);
    }
}

/**
 * Register all built-in tools on a server instance.
 * Used for HTTP mode where each session gets its own McpServer.
 * In stdio mode, tools are registered on the module-level `server` directly (above).
 */
function registerAllTools(s: McpServer) {
    // Auth extraction
    s.tool(
        "extract_auth",
        "Extract auth tokens from the user's logged-in browser session. Supports: slack, discord, linkedin, twitter, github, notion, or any domain. Use profile to store credentials under a named profile.",
        { service: z.string().describe("Service name or domain"), profile: z.string().optional().describe("Profile name (e.g. 'personal', 'business'). Omit for default.") },
        async ({ service, profile }) => {
            if (!isBridgeConnected()) {
                return { content: [{ type: "text", text: "Browser extension not connected. Install the Neo Bridge extension and make sure Chrome is running." }] };
            }
            const result = await browserCommand("extract_auth", { service });
            const storageKey = profileKey(service, profile);
            const creds: Record<string, string> = {};
            for (const [key, value] of Object.entries(result)) {
                if (key === "service" || !value || typeof value !== "string") continue;
                creds[key] = value as string;
                try { db.storeCredential(storageKey, key, value as string); } catch {}
            }
            if (Array.isArray(result.cookies) && result.cookies.length > 0) {
                const cookieHeader = result.cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
                creds._cookies = cookieHeader;
                try { db.storeCredential(storageKey, "_cookies", cookieHeader); } catch {}
            }
            storeAuthInMemory(storageKey, creds);
            const label = profile ? ` as profile "${profile}"` : "";
            return { content: [{ type: "text", text: `Stored${label}.\n${json(result)}` }] };
        }
    );

    // Authenticated fetch
    s.tool(
        "authenticated_fetch",
        `Make an HTTP request from the browser's context, carrying the page's cookies, auth, and session. Works on ANY website the user is logged into.`,
        {
            url: z.string().describe("URL to fetch"),
            method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            body: z.string().optional(),
        },
        async ({ url, method, headers, body }) => {
            if (!isBridgeConnected()) {
                return { content: [{ type: "text", text: "Browser extension not connected." }] };
            }
            const result = await browserCommand("browser_fetch", { url, method, headers, body, credentials: "include" });
            const text = typeof result === "string" ? result : json(result);
            return { content: [{ type: "text", text: text.slice(0, 50000) }] };
        }
    );

    // Network capture
    s.tool("network_capture", "Start/stop/clear network request capture in the browser.",
        { action: z.enum(["start", "stop", "clear"]), filters: z.array(z.string()).optional(), navigate: z.string().optional() },
        async ({ action, filters, navigate }) => {
            if (!isBridgeConnected()) return { content: [{ type: "text", text: "Browser extension not connected." }] };
            if (action === "start") { await browserCommand("network_start_capture", { filters: filters || [] }); if (navigate) await browserCommand("navigate", { url: navigate }); return { content: [{ type: "text", text: "Capture started." }] }; }
            if (action === "stop") { await browserCommand("network_stop_capture"); return { content: [{ type: "text", text: "Capture stopped." }] }; }
            await browserCommand("network_clear"); return { content: [{ type: "text", text: "Capture cleared." }] };
        }
    );

    s.tool("network_requests", "List captured network requests.",
        { filter: z.string().optional(), limit: z.number().optional() },
        async ({ filter, limit }) => {
            if (!isBridgeConnected()) return { content: [{ type: "text", text: "Browser extension not connected." }] };
            const data = await browserCommand("network_list", { filter, limit: limit || 100 });
            const entries = data?.requests || [];
            const lines = entries.map((r: any) => `[${r.id}] ${r.method} ${r.status || "?"} ${r.url}`);
            return { content: [{ type: "text", text: lines.length > 0 ? `${data.total} requests captured:\n${lines.join("\n")}` : "No requests captured." }] };
        }
    );

    s.tool("network_request_detail", "Get full details for a captured request.",
        { id: z.string().describe("Request ID from network_requests") },
        async ({ id }) => {
            if (!isBridgeConnected()) return { content: [{ type: "text", text: "Browser extension not connected." }] };
            const detail = await browserCommand("network_get_request", { id });
            return { content: [{ type: "text", text: json(detail) }] };
        }
    );

    s.tool("bridge_status", "Check if the Neo Browser Bridge extension is connected.", {},
        async () => ({ content: [{ type: "text", text: isBridgeConnected() ? "Connected." : "Not connected. Make sure Chrome is running with the Neo Bridge extension." }] })
    );

    // LinkedIn
    s.tool("linkedin_profile", "Get a LinkedIn user's profile.", { vanity_name: z.string(), ...profileParam },
        async ({ vanity_name, profile }) => ({ content: [{ type: "text", text: json(await linkedin.getProfile(getLinkedInAuth(profile), vanity_name)) }] }));
    s.tool("linkedin_my_posts", "Get your own LinkedIn posts with engagement metrics.", { count: z.number().optional(), ...profileParam },
        async ({ count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.getMyPosts(getLinkedInAuth(profile), count || 20)) }] }));
    s.tool("linkedin_profile_posts", "Get a LinkedIn user's posts by vanity name.", { vanity_name: z.string(), count: z.number().optional(), ...profileParam },
        async ({ vanity_name, count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.getProfilePosts(getLinkedInAuth(profile), vanity_name, count || 20)) }] }));
    s.tool("linkedin_feed", "Get your LinkedIn feed.", { count: z.number().optional(), ...profileParam },
        async ({ count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.getFeed(getLinkedInAuth(profile), count || 20)) }] }));
    s.tool("linkedin_post", "Create a LinkedIn post.", { text: z.string(), ...profileParam },
        async ({ text, profile }) => ({ content: [{ type: "text", text: json(await linkedin.createPost(getLinkedInAuth(profile), text)) }] }));
    s.tool("linkedin_search", "Search for people on LinkedIn.", { query: z.string(), count: z.number().optional(), ...profileParam },
        async ({ query, count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.searchPeople(getLinkedInAuth(profile), query, count || 10)) }] }));
    s.tool("linkedin_connections", "List your LinkedIn connections.", { count: z.number().optional(), ...profileParam },
        async ({ count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.getConnections(getLinkedInAuth(profile), count || 50)) }] }));
    s.tool("linkedin_conversations", "List your recent LinkedIn message conversations.", { count: z.number().optional(), ...profileParam },
        async ({ count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.getConversations(getLinkedInAuth(profile), count || 20)) }] }));
    s.tool("linkedin_messages", "Get messages in a specific LinkedIn conversation.", { conversation_id: z.string(), count: z.number().optional(), ...profileParam },
        async ({ conversation_id, count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.getConversationMessages(getLinkedInAuth(profile), conversation_id, count || 20)) }] }));
    s.tool("linkedin_send_message", "Send a LinkedIn message.", { recipient: z.string(), message: z.string(), ...profileParam },
        async ({ recipient, message, profile }) => ({ content: [{ type: "text", text: json(await linkedin.sendMessage(getLinkedInAuth(profile), recipient, message)) }] }));
    s.tool("linkedin_react", "React to a LinkedIn post.", { post_urn: z.string(), reaction: z.enum(["LIKE", "CELEBRATE", "SUPPORT", "LOVE", "INSIGHTFUL", "FUNNY"]).optional(), ...profileParam },
        async ({ post_urn, reaction, profile }) => ({ content: [{ type: "text", text: json(await linkedin.reactToPost(getLinkedInAuth(profile), post_urn, reaction || "LIKE")) }] }));
    s.tool("linkedin_comment", "Comment on a LinkedIn post.", { post_urn: z.string(), text: z.string(), ...profileParam },
        async ({ post_urn, text, profile }) => ({ content: [{ type: "text", text: json(await linkedin.commentOnPost(getLinkedInAuth(profile), post_urn, text)) }] }));
    s.tool("linkedin_post_comments", "Get comments on a LinkedIn post.", { post_urn: z.string(), count: z.number().optional(), ...profileParam },
        async ({ post_urn, count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.getPostComments(getLinkedInAuth(profile), post_urn, count || 20)) }] }));
    s.tool("linkedin_notifications", "Get your recent LinkedIn notifications.", { count: z.number().optional(), ...profileParam },
        async ({ count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.getNotifications(getLinkedInAuth(profile), count || 20)) }] }));
    s.tool("linkedin_send_connection", "Send a connection request.", { vanity_name: z.string(), message: z.string().optional(), ...profileParam },
        async ({ vanity_name, message, profile }) => ({ content: [{ type: "text", text: json(await linkedin.sendConnectionRequest(getLinkedInAuth(profile), vanity_name, message)) }] }));
    s.tool("linkedin_invitations", "Get pending connection requests.", { count: z.number().optional(), ...profileParam },
        async ({ count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.getInvitations(getLinkedInAuth(profile), count || 20)) }] }));
    s.tool("linkedin_respond_invitation", "Accept or decline a connection request.", { invitation_id: z.string(), accept: z.boolean(), ...profileParam },
        async ({ invitation_id, accept, profile }) => ({ content: [{ type: "text", text: json(await linkedin.respondToInvitation(getLinkedInAuth(profile), invitation_id, accept)) }] }));

    // Twitter
    s.tool("twitter_profile", "Get a Twitter/X user's profile.", { screen_name: z.string(), ...profileParam },
        async ({ screen_name, profile }) => ({ content: [{ type: "text", text: json(await twitter.getProfile(getTwitterAuth(profile), screen_name)) }] }));
    s.tool("twitter_user_tweets", "Get a user's tweets with engagement metrics.", { screen_name: z.string(), count: z.number().optional(), ...profileParam },
        async ({ screen_name, count, profile }) => ({ content: [{ type: "text", text: json(await twitter.getUserTweets(getTwitterAuth(profile), screen_name, count || 20)) }] }));
    s.tool("twitter_timeline", "Get your home timeline.", { count: z.number().optional(), ...profileParam },
        async ({ count, profile }) => ({ content: [{ type: "text", text: json(await twitter.getTimeline(getTwitterAuth(profile), count || 20)) }] }));
    s.tool("twitter_post", "Post a tweet.", { text: z.string(), reply_to: z.string().optional(), ...profileParam },
        async ({ text, reply_to, profile }) => ({ content: [{ type: "text", text: json(await twitter.createTweet(getTwitterAuth(profile), text, reply_to)) }] }));
    s.tool("twitter_search", "Search tweets.", { query: z.string(), count: z.number().optional(), ...profileParam },
        async ({ query, count, profile }) => ({ content: [{ type: "text", text: json(await twitter.searchTweets(getTwitterAuth(profile), query, count || 20)) }] }));

    // GitHub
    s.tool("github_me", "Get your authenticated GitHub profile.", { ...profileParam },
        async ({ profile }) => ({ content: [{ type: "text", text: json(await github.getAuthenticatedUser(getGitHubAuth(profile))) }] }));
    s.tool("github_user", "Get a GitHub user's profile.", { username: z.string(), ...profileParam },
        async ({ username, profile }) => ({ content: [{ type: "text", text: json(await github.getUserProfile(getGitHubAuth(profile), username)) }] }));
    s.tool("github_repos", "List your GitHub repos.", { count: z.number().optional(), sort: z.enum(["updated", "created", "pushed", "full_name"]).optional(), ...profileParam },
        async ({ count, sort, profile }) => ({ content: [{ type: "text", text: json(await github.listMyRepos(getGitHubAuth(profile), count || 30, sort || "updated")) }] }));
    s.tool("github_repo", "Get details about a GitHub repo.", { owner: z.string(), repo: z.string(), ...profileParam },
        async ({ owner, repo, profile }) => ({ content: [{ type: "text", text: json(await github.getRepo(getGitHubAuth(profile), owner, repo)) }] }));
    s.tool("github_search_repos", "Search GitHub repositories.", { query: z.string(), count: z.number().optional(), ...profileParam },
        async ({ query, count, profile }) => ({ content: [{ type: "text", text: json(await github.searchRepos(getGitHubAuth(profile), query, count || 20)) }] }));
    s.tool("github_issues", "List issues for a repo.", { owner: z.string(), repo: z.string(), state: z.enum(["open", "closed", "all"]).optional(), labels: z.string().optional(), count: z.number().optional(), ...profileParam },
        async ({ owner, repo, state, labels, count, profile }) => ({ content: [{ type: "text", text: json(await github.listIssues(getGitHubAuth(profile), owner, repo, { state, labels, count })) }] }));
    s.tool("github_issue", "Get a specific issue.", { owner: z.string(), repo: z.string(), number: z.number(), ...profileParam },
        async ({ owner, repo, number, profile }) => ({ content: [{ type: "text", text: json(await github.getIssue(getGitHubAuth(profile), owner, repo, number)) }] }));
    s.tool("github_create_issue", "Create a GitHub issue.", { owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional(), ...profileParam },
        async ({ owner, repo, title, body, labels, assignees, profile }) => ({ content: [{ type: "text", text: json(await github.createIssue(getGitHubAuth(profile), owner, repo, title, body, labels, assignees)) }] }));
    s.tool("github_comment_issue", "Comment on a GitHub issue or PR.", { owner: z.string(), repo: z.string(), number: z.number(), body: z.string(), ...profileParam },
        async ({ owner, repo, number, body, profile }) => ({ content: [{ type: "text", text: json(await github.commentOnIssue(getGitHubAuth(profile), owner, repo, number, body)) }] }));
    s.tool("github_prs", "List pull requests for a repo.", { owner: z.string(), repo: z.string(), state: z.enum(["open", "closed", "all"]).optional(), count: z.number().optional(), ...profileParam },
        async ({ owner, repo, state, count, profile }) => ({ content: [{ type: "text", text: json(await github.listPRs(getGitHubAuth(profile), owner, repo, { state, count })) }] }));
    s.tool("github_pr", "Get details about a pull request.", { owner: z.string(), repo: z.string(), number: z.number(), ...profileParam },
        async ({ owner, repo, number, profile }) => ({ content: [{ type: "text", text: json(await github.getPR(getGitHubAuth(profile), owner, repo, number)) }] }));
    s.tool("github_pr_files", "Get files changed in a pull request.", { owner: z.string(), repo: z.string(), number: z.number(), ...profileParam },
        async ({ owner, repo, number, profile }) => ({ content: [{ type: "text", text: json(await github.getPRFiles(getGitHubAuth(profile), owner, repo, number)) }] }));
    s.tool("github_create_pr", "Create a pull request.", { owner: z.string(), repo: z.string(), title: z.string(), head: z.string(), base: z.string(), body: z.string().optional(), draft: z.boolean().optional(), ...profileParam },
        async ({ owner, repo, title, head, base, body, draft, profile }) => ({ content: [{ type: "text", text: json(await github.createPR(getGitHubAuth(profile), owner, repo, title, head, base, body, draft)) }] }));
    s.tool("github_merge_pr", "Merge a pull request.", { owner: z.string(), repo: z.string(), number: z.number(), method: z.enum(["merge", "squash", "rebase"]).optional(), commit_message: z.string().optional(), ...profileParam },
        async ({ owner, repo, number, method, commit_message, profile }) => ({ content: [{ type: "text", text: json(await github.mergePR(getGitHubAuth(profile), owner, repo, number, method || "merge", commit_message)) }] }));
    s.tool("github_pr_reviews", "Get reviews on a pull request.", { owner: z.string(), repo: z.string(), number: z.number(), ...profileParam },
        async ({ owner, repo, number, profile }) => ({ content: [{ type: "text", text: json(await github.getPRReviews(getGitHubAuth(profile), owner, repo, number)) }] }));
    s.tool("github_review_pr", "Submit a review on a pull request.", { owner: z.string(), repo: z.string(), number: z.number(), event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: z.string().optional(), ...profileParam },
        async ({ owner, repo, number, event, body, profile }) => ({ content: [{ type: "text", text: json(await github.createPRReview(getGitHubAuth(profile), owner, repo, number, event, body)) }] }));
    s.tool("github_notifications", "Get your GitHub notifications.", { count: z.number().optional(), all: z.boolean().optional(), ...profileParam },
        async ({ count, all, profile }) => ({ content: [{ type: "text", text: json(await github.getNotifications(getGitHubAuth(profile), count || 30, all || false)) }] }));
    s.tool("github_mark_notification_read", "Mark a notification as read.", { thread_id: z.string(), ...profileParam },
        async ({ thread_id, profile }) => { await github.markNotificationRead(getGitHubAuth(profile), thread_id); return { content: [{ type: "text", text: "Marked as read." }] }; });
    s.tool("github_search_code", "Search code on GitHub.", { query: z.string(), count: z.number().optional(), ...profileParam },
        async ({ query, count, profile }) => ({ content: [{ type: "text", text: json(await github.searchCode(getGitHubAuth(profile), query, count || 20)) }] }));
    s.tool("github_search_users", "Search GitHub users.", { query: z.string(), count: z.number().optional(), ...profileParam },
        async ({ query, count, profile }) => ({ content: [{ type: "text", text: json(await github.searchUsers(getGitHubAuth(profile), query, count || 20)) }] }));
    s.tool("github_starred", "List your starred repos.", { count: z.number().optional(), ...profileParam },
        async ({ count, profile }) => ({ content: [{ type: "text", text: json(await github.listStarred(getGitHubAuth(profile), count || 30)) }] }));
    s.tool("github_star", "Star a repo.", { owner: z.string(), repo: z.string(), ...profileParam },
        async ({ owner, repo, profile }) => { await github.starRepo(getGitHubAuth(profile), owner, repo); return { content: [{ type: "text", text: "Starred." }] }; });
    s.tool("github_unstar", "Unstar a repo.", { owner: z.string(), repo: z.string(), ...profileParam },
        async ({ owner, repo, profile }) => { await github.unstarRepo(getGitHubAuth(profile), owner, repo); return { content: [{ type: "text", text: "Unstarred." }] }; });
    s.tool("github_gists", "List your gists.", { count: z.number().optional(), ...profileParam },
        async ({ count, profile }) => ({ content: [{ type: "text", text: json(await github.listGists(getGitHubAuth(profile), count || 20)) }] }));
    s.tool("github_create_gist", "Create a gist.", { files: z.record(z.string(), z.string()).describe("Filename → content map"), description: z.string().optional(), public: z.boolean().optional(), ...profileParam },
        async ({ files, description, public: isPublic, profile }) => ({ content: [{ type: "text", text: json(await github.createGist(getGitHubAuth(profile), files, description, isPublic || false)) }] }));
    s.tool("github_actions", "List recent workflow runs.", { owner: z.string(), repo: z.string(), count: z.number().optional(), ...profileParam },
        async ({ owner, repo, count, profile }) => ({ content: [{ type: "text", text: json(await github.listWorkflowRuns(getGitHubAuth(profile), owner, repo, count || 10)) }] }));
    s.tool("github_action_run", "Get details about a workflow run.", { owner: z.string(), repo: z.string(), run_id: z.number(), ...profileParam },
        async ({ owner, repo, run_id, profile }) => ({ content: [{ type: "text", text: json(await github.getWorkflowRun(getGitHubAuth(profile), owner, repo, run_id)) }] }));
    s.tool("github_rerun_workflow", "Re-run a failed workflow.", { owner: z.string(), repo: z.string(), run_id: z.number(), ...profileParam },
        async ({ owner, repo, run_id, profile }) => { await github.rerunWorkflow(getGitHubAuth(profile), owner, repo, run_id); return { content: [{ type: "text", text: "Re-run triggered." }] }; });
    s.tool("github_file", "Get file or directory contents from a repo.", { owner: z.string(), repo: z.string(), path: z.string(), ref: z.string().optional().describe("Branch, tag, or commit SHA"), ...profileParam },
        async ({ owner, repo, path, ref, profile }) => ({ content: [{ type: "text", text: json(await github.getFileContent(getGitHubAuth(profile), owner, repo, path, ref)) }] }));

    // Google Calendar
    s.tool("gcal_connect", "Connect a Google Calendar account via OAuth.", { profile: z.string().optional() },
        async ({ profile }) => {
            const authUrl = `http://127.0.0.1:${httpPort}/gcal/auth${profile ? `?profile=${profile}` : ""}`;
            try { await browserCommand("navigate", { url: authUrl }); } catch {}
            const storageKey = profileKey("gcal", profile);
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 2000));
                const creds = memCredentials.get(storageKey);
                if (creds?.refresh_token) { return { content: [{ type: "text", text: `Google Calendar connected${profile ? ` as "${profile}"` : ""}.` }] }; }
            }
            return { content: [{ type: "text", text: `Timed out. Visit ${authUrl} manually.` }] };
        });
    s.tool("gcal_calendars", "List your Google Calendar calendars.", { ...profileParam },
        async ({ profile }) => ({ content: [{ type: "text", text: json(await gcal.listCalendars(await getGCalAuth(profile))) }] }));
    s.tool("gcal_events", "List upcoming calendar events.", { calendar_id: z.string().optional(), time_min: z.string().optional(), time_max: z.string().optional(), max_results: z.number().optional(), query: z.string().optional(), ...profileParam },
        async ({ calendar_id, time_min, time_max, max_results, query, profile }) => ({ content: [{ type: "text", text: json(await gcal.listEvents(await getGCalAuth(profile), calendar_id || "primary", { timeMin: time_min, timeMax: time_max, maxResults: max_results, query })) }] }));
    s.tool("gcal_event", "Get a specific calendar event.", { calendar_id: z.string().optional(), event_id: z.string(), ...profileParam },
        async ({ calendar_id, event_id, profile }) => ({ content: [{ type: "text", text: json(await gcal.getEvent(await getGCalAuth(profile), calendar_id || "primary", event_id)) }] }));
    s.tool("gcal_create_event", "Create a calendar event.", { summary: z.string(), description: z.string().optional(), location: z.string().optional(), start: z.string(), end: z.string(), attendees: z.array(z.string()).optional(), time_zone: z.string().optional(), calendar_id: z.string().optional(), recurrence: z.array(z.string()).optional(), add_meet: z.boolean().optional(), ...profileParam },
        async ({ summary, description, location, start, end, attendees, time_zone, calendar_id, recurrence, add_meet, profile }) => ({ content: [{ type: "text", text: json(await gcal.createEvent(await getGCalAuth(profile), calendar_id || "primary", { summary, description, location, start, end, attendees, timeZone: time_zone, recurrence, conferenceData: add_meet })) }] }));
    s.tool("gcal_update_event", "Update a calendar event.", { event_id: z.string(), calendar_id: z.string().optional(), summary: z.string().optional(), description: z.string().optional(), location: z.string().optional(), start: z.string().optional(), end: z.string().optional(), time_zone: z.string().optional(), ...profileParam },
        async ({ event_id, calendar_id, summary, description, location, start, end, time_zone, profile }) => ({ content: [{ type: "text", text: json(await gcal.updateEvent(await getGCalAuth(profile), calendar_id || "primary", event_id, { summary, description, location, start, end, timeZone: time_zone })) }] }));
    s.tool("gcal_delete_event", "Delete a calendar event.", { event_id: z.string(), calendar_id: z.string().optional(), ...profileParam },
        async ({ event_id, calendar_id, profile }) => { await gcal.deleteEvent(await getGCalAuth(profile), calendar_id || "primary", event_id); return { content: [{ type: "text", text: "Event deleted." }] }; });
    s.tool("gcal_respond", "Respond to a calendar invite.", { event_id: z.string(), response: z.enum(["accepted", "declined", "tentative"]), calendar_id: z.string().optional(), ...profileParam },
        async ({ event_id, response, calendar_id, profile }) => ({ content: [{ type: "text", text: json(await gcal.respondToEvent(await getGCalAuth(profile), calendar_id || "primary", event_id, response)) }] }));
    s.tool("gcal_quick_add", "Create an event from natural language text.", { text: z.string(), calendar_id: z.string().optional(), ...profileParam },
        async ({ text, calendar_id, profile }) => ({ content: [{ type: "text", text: json(await gcal.quickAddEvent(await getGCalAuth(profile), calendar_id || "primary", text)) }] }));
    s.tool("gcal_freebusy", "Check free/busy status for calendars.", { calendar_ids: z.array(z.string()).optional(), time_min: z.string(), time_max: z.string(), ...profileParam },
        async ({ calendar_ids, time_min, time_max, profile }) => ({ content: [{ type: "text", text: json(await gcal.freeBusy(await getGCalAuth(profile), calendar_ids || ["primary"], time_min, time_max)) }] }));

    // Notion
    s.tool("notion_spaces", "List your Notion workspaces.", { ...profileParam },
        async ({ profile }) => ({ content: [{ type: "text", text: json(await notion.getSpaces(getNotionAuth(profile))) }] }));
    s.tool("notion_search", "Search Notion pages and databases.", { query: z.string(), limit: z.number().optional(), type: z.string().optional(), ...profileParam },
        async ({ query, limit, type, profile }) => ({ content: [{ type: "text", text: json(await notion.search(getNotionAuth(profile), query, { limit, type })) }] }));
    s.tool("notion_page", "Get a Notion page with its child blocks.", { page_id: z.string(), ...profileParam },
        async ({ page_id, profile }) => ({ content: [{ type: "text", text: json(await notion.getPage(getNotionAuth(profile), page_id)) }] }));
    s.tool("notion_page_content", "Get a Notion page's content as readable markdown.", { page_id: z.string(), ...profileParam },
        async ({ page_id, profile }) => ({ content: [{ type: "text", text: await notion.getPageContent(getNotionAuth(profile), page_id) }] }));
    s.tool("notion_block", "Get a specific Notion block.", { block_id: z.string(), ...profileParam },
        async ({ block_id, profile }) => ({ content: [{ type: "text", text: json(await notion.getBlock(getNotionAuth(profile), block_id)) }] }));
    s.tool("notion_create_page", "Create a new Notion page.", { parent_id: z.string(), title: z.string(), content: z.string().optional(), ...profileParam },
        async ({ parent_id, title, content, profile }) => ({ content: [{ type: "text", text: json(await notion.createPage(getNotionAuth(profile), parent_id, title, content)) }] }));
    s.tool("notion_append", "Append a block to a Notion page.", { page_id: z.string(), text: z.string(), type: z.enum(["text", "header", "sub_header", "bulleted_list", "numbered_list", "to_do", "toggle", "quote", "code", "divider"]).optional(), ...profileParam },
        async ({ page_id, text, type, profile }) => ({ content: [{ type: "text", text: json(await notion.appendBlock(getNotionAuth(profile), page_id, text, type || "text")) }] }));
    s.tool("notion_update_block", "Update the text of a Notion block.", { block_id: z.string(), text: z.string(), ...profileParam },
        async ({ block_id, text, profile }) => ({ content: [{ type: "text", text: json(await notion.updateBlock(getNotionAuth(profile), block_id, text)) }] }));
    s.tool("notion_delete_block", "Delete a Notion block.", { block_id: z.string(), ...profileParam },
        async ({ block_id, profile }) => { await notion.deleteBlock(getNotionAuth(profile), block_id); return { content: [{ type: "text", text: "Block deleted." }] }; });
    s.tool("notion_database", "Query a Notion database.", { collection_id: z.string(), view_id: z.string(), limit: z.number().optional(), query: z.string().optional(), ...profileParam },
        async ({ collection_id, view_id, limit, query, profile }) => ({ content: [{ type: "text", text: json(await notion.queryDatabase(getNotionAuth(profile), collection_id, view_id, { limit, query })) }] }));
    s.tool("notion_recent", "Get recently visited Notion pages.", { limit: z.number().optional(), ...profileParam },
        async ({ limit, profile }) => ({ content: [{ type: "text", text: json(await notion.getRecentPages(getNotionAuth(profile), limit || 20)) }] }));

    // Discord
    s.tool("discord_me", "Get your Discord profile.", { ...profileParam },
        async ({ profile }) => ({ content: [{ type: "text", text: json(await discord.getMe(getDiscordAuth(profile))) }] }));
    s.tool("discord_guilds", "List your Discord servers.", { ...profileParam },
        async ({ profile }) => ({ content: [{ type: "text", text: json(await discord.listGuilds(getDiscordAuth(profile))) }] }));
    s.tool("discord_guild", "Get Discord server details.", { guild_id: z.string(), ...profileParam },
        async ({ guild_id, profile }) => ({ content: [{ type: "text", text: json(await discord.getGuild(getDiscordAuth(profile), guild_id)) }] }));
    s.tool("discord_channels", "List channels in a Discord server.", { guild_id: z.string(), ...profileParam },
        async ({ guild_id, profile }) => ({ content: [{ type: "text", text: json(await discord.listChannels(getDiscordAuth(profile), guild_id)) }] }));
    s.tool("discord_messages", "Read messages from a Discord channel.", { channel_id: z.string(), limit: z.number().optional(), ...profileParam },
        async ({ channel_id, limit, profile }) => ({ content: [{ type: "text", text: json(await discord.readMessages(getDiscordAuth(profile), channel_id, limit || 50)) }] }));
    s.tool("discord_send", "Send a message to a Discord channel.", { channel_id: z.string(), content: z.string(), ...profileParam },
        async ({ channel_id, content, profile }) => ({ content: [{ type: "text", text: json(await discord.sendMessage(getDiscordAuth(profile), channel_id, content)) }] }));
    s.tool("discord_channel", "Get Discord channel info.", { channel_id: z.string(), ...profileParam },
        async ({ channel_id, profile }) => ({ content: [{ type: "text", text: json(await discord.getChannel(getDiscordAuth(profile), channel_id)) }] }));
    s.tool("discord_search", "Search messages in a Discord server.", { guild_id: z.string(), query: z.string(), limit: z.number().optional(), ...profileParam },
        async ({ guild_id, query, limit, profile }) => ({ content: [{ type: "text", text: json(await discord.searchMessages(getDiscordAuth(profile), guild_id, query, limit || 25)) }] }));
    s.tool("discord_dms", "List your Discord DM channels.", { ...profileParam },
        async ({ profile }) => ({ content: [{ type: "text", text: json(await discord.listDMs(getDiscordAuth(profile))) }] }));
    s.tool("discord_read_dm", "Read DM messages.", { channel_id: z.string(), limit: z.number().optional(), ...profileParam },
        async ({ channel_id, limit, profile }) => ({ content: [{ type: "text", text: json(await discord.readDMs(getDiscordAuth(profile), channel_id, limit || 50)) }] }));
    s.tool("discord_send_dm", "Send a DM to a user.", { user_id: z.string(), content: z.string(), ...profileParam },
        async ({ user_id, content, profile }) => ({ content: [{ type: "text", text: json(await discord.sendDM(getDiscordAuth(profile), user_id, content)) }] }));
    s.tool("discord_react", "Add a reaction.", { channel_id: z.string(), message_id: z.string(), emoji: z.string(), ...profileParam },
        async ({ channel_id, message_id, emoji, profile }) => { await discord.addReaction(getDiscordAuth(profile), channel_id, message_id, emoji); return { content: [{ type: "text", text: "Reaction added." }] }; });
    s.tool("discord_unreact", "Remove a reaction.", { channel_id: z.string(), message_id: z.string(), emoji: z.string(), ...profileParam },
        async ({ channel_id, message_id, emoji, profile }) => { await discord.removeReaction(getDiscordAuth(profile), channel_id, message_id, emoji); return { content: [{ type: "text", text: "Reaction removed." }] }; });
    s.tool("discord_members", "List server members.", { guild_id: z.string(), limit: z.number().optional(), ...profileParam },
        async ({ guild_id, limit, profile }) => ({ content: [{ type: "text", text: json(await discord.getGuildMembers(getDiscordAuth(profile), guild_id, limit || 100)) }] }));
    s.tool("discord_user", "Get a Discord user's profile.", { user_id: z.string(), ...profileParam },
        async ({ user_id, profile }) => ({ content: [{ type: "text", text: json(await discord.getUserProfile(getDiscordAuth(profile), user_id)) }] }));

    // Google Drive
    s.tool("gdrive_connect", "Connect a Google Drive account via OAuth.", { profile: z.string().optional() },
        async ({ profile }) => {
            const authUrl = `http://127.0.0.1:${httpPort}/gdrive/auth${profile ? `?profile=${profile}` : ""}`;
            try { await browserCommand("navigate", { url: authUrl }); } catch {}
            const storageKey = profileKey("gdrive", profile);
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline) { await new Promise(r => setTimeout(r, 2000)); const c = memCredentials.get(storageKey); if (c?.refresh_token) return { content: [{ type: "text", text: `Google Drive connected${profile ? ` as "${profile}"` : ""}.` }] }; }
            return { content: [{ type: "text", text: `Timed out. Visit ${authUrl} manually.` }] };
        });
    s.tool("gdrive_files", "List files in Google Drive.", { query: z.string().optional(), folder_id: z.string().optional(), page_size: z.number().optional(), order_by: z.string().optional(), ...profileParam },
        async ({ query, folder_id, page_size, order_by, profile }) => ({ content: [{ type: "text", text: json(await gdrive.listFiles(await getGDriveAuth(profile), { query, folderId: folder_id, pageSize: page_size, orderBy: order_by })) }] }));
    s.tool("gdrive_file", "Get file metadata.", { file_id: z.string(), ...profileParam },
        async ({ file_id, profile }) => ({ content: [{ type: "text", text: json(await gdrive.getFile(await getGDriveAuth(profile), file_id)) }] }));
    s.tool("gdrive_search", "Search files by name.", { query: z.string(), page_size: z.number().optional(), ...profileParam },
        async ({ query, page_size, profile }) => ({ content: [{ type: "text", text: json(await gdrive.searchFiles(await getGDriveAuth(profile), query, page_size)) }] }));
    s.tool("gdrive_read", "Read file content.", { file_id: z.string(), ...profileParam },
        async ({ file_id, profile }) => ({ content: [{ type: "text", text: json(await gdrive.getFileContent(await getGDriveAuth(profile), file_id)) }] }));
    s.tool("gdrive_create", "Create a file.", { name: z.string(), content: z.string(), mime_type: z.string().optional(), folder_id: z.string().optional(), ...profileParam },
        async ({ name, content, mime_type, folder_id, profile }) => ({ content: [{ type: "text", text: json(await gdrive.createFile(await getGDriveAuth(profile), name, content, mime_type, folder_id)) }] }));
    s.tool("gdrive_update", "Update a file's content.", { file_id: z.string(), content: z.string(), mime_type: z.string().optional(), ...profileParam },
        async ({ file_id, content, mime_type, profile }) => ({ content: [{ type: "text", text: json(await gdrive.updateFile(await getGDriveAuth(profile), file_id, content, mime_type)) }] }));
    s.tool("gdrive_delete", "Move a file to trash.", { file_id: z.string(), ...profileParam },
        async ({ file_id, profile }) => { await gdrive.deleteFile(await getGDriveAuth(profile), file_id); return { content: [{ type: "text", text: "File trashed." }] }; });
    s.tool("gdrive_create_folder", "Create a folder.", { name: z.string(), parent_id: z.string().optional(), ...profileParam },
        async ({ name, parent_id, profile }) => ({ content: [{ type: "text", text: json(await gdrive.createFolder(await getGDriveAuth(profile), name, parent_id)) }] }));
    s.tool("gdrive_shared_drives", "List shared drives.", { ...profileParam },
        async ({ profile }) => ({ content: [{ type: "text", text: json(await gdrive.listSharedDrives(await getGDriveAuth(profile))) }] }));
    s.tool("gdrive_quota", "Get storage quota.", { ...profileParam },
        async ({ profile }) => ({ content: [{ type: "text", text: json(await gdrive.getStorageQuota(await getGDriveAuth(profile))) }] }));

    // Slack
    s.tool("slack_channels", "List Slack channels.", { ...profileParam },
        async ({ profile }) => ({ content: [{ type: "text", text: json(await slack.listChannels(getSlackAuth(profile))) }] }));
    s.tool("slack_channel_info", "Get details about a Slack channel.", { channel: z.string(), ...profileParam },
        async ({ channel, profile }) => ({ content: [{ type: "text", text: json(await slack.getChannelInfo(getSlackAuth(profile), channel)) }] }));
    s.tool("slack_read", "Read messages from a Slack channel.", { channel: z.string(), limit: z.number().optional(), oldest: z.number().optional(), latest: z.number().optional(), ...profileParam },
        async ({ channel, limit, oldest, latest, profile }) => ({ content: [{ type: "text", text: json(await slack.readMessages(getSlackAuth(profile), channel, { limit: limit || 50, oldest, latest })) }] }));
    s.tool("slack_thread", "Read a Slack thread.", { channel: z.string(), thread_ts: z.string(), limit: z.number().optional(), ...profileParam },
        async ({ channel, thread_ts, limit, profile }) => ({ content: [{ type: "text", text: json(await slack.readThread(getSlackAuth(profile), channel, thread_ts, limit || 50)) }] }));
    s.tool("slack_dms", "Read recent DMs.", { limit: z.number().optional(), ...profileParam },
        async ({ limit, profile }) => ({ content: [{ type: "text", text: json(await slack.readDMs(getSlackAuth(profile), limit || 20)) }] }));
    s.tool("slack_search", "Search Slack messages.", { query: z.string(), limit: z.number().optional(), sort: z.enum(["score", "timestamp"]).optional(), ...profileParam },
        async ({ query, limit, sort, profile }) => ({ content: [{ type: "text", text: json(await slack.searchMessages(getSlackAuth(profile), query, { limit: limit || 20, sort })) }] }));
    s.tool("slack_send", "Send a message to a Slack channel or DM.", { channel: z.string(), text: z.string(), thread_ts: z.string().optional(), ...profileParam },
        async ({ channel, text, thread_ts, profile }) => { const ts = await slack.postMessage(getSlackAuth(profile), channel, text, thread_ts); return { content: [{ type: "text", text: `Sent (ts: ${ts}).` }] }; });
    s.tool("slack_react", "Add a reaction emoji to a message.", { channel: z.string(), timestamp: z.string(), emoji: z.string(), ...profileParam },
        async ({ channel, timestamp, emoji, profile }) => { await slack.addReaction(getSlackAuth(profile), channel, timestamp, emoji); return { content: [{ type: "text", text: "Reacted." }] }; });
    s.tool("slack_unreact", "Remove a reaction from a message.", { channel: z.string(), timestamp: z.string(), emoji: z.string(), ...profileParam },
        async ({ channel, timestamp, emoji, profile }) => { await slack.removeReaction(getSlackAuth(profile), channel, timestamp, emoji); return { content: [{ type: "text", text: "Reaction removed." }] }; });
    s.tool("slack_edit", "Edit a Slack message.", { channel: z.string(), timestamp: z.string(), text: z.string(), ...profileParam },
        async ({ channel, timestamp, text, profile }) => { await slack.updateMessage(getSlackAuth(profile), channel, timestamp, text); return { content: [{ type: "text", text: "Message updated." }] }; });
    s.tool("slack_delete", "Delete a Slack message.", { channel: z.string(), timestamp: z.string(), ...profileParam },
        async ({ channel, timestamp, profile }) => { await slack.deleteMessage(getSlackAuth(profile), channel, timestamp); return { content: [{ type: "text", text: "Deleted." }] }; });
    s.tool("slack_users", "List Slack workspace users.", { ...profileParam },
        async ({ profile }) => ({ content: [{ type: "text", text: json(await slack.listUsers(getSlackAuth(profile))) }] }));
    s.tool("slack_user_profile", "Get a Slack user's profile.", { user_id: z.string(), ...profileParam },
        async ({ user_id, profile }) => ({ content: [{ type: "text", text: json(await slack.getUserProfile(getSlackAuth(profile), user_id)) }] }));
    s.tool("slack_set_status", "Set your Slack status.", { text: z.string(), emoji: z.string().optional(), expiration: z.number().optional(), ...profileParam },
        async ({ text, emoji, expiration, profile }) => { await slack.setStatus(getSlackAuth(profile), text, emoji, expiration); return { content: [{ type: "text", text: "Status set." }] }; });
    s.tool("slack_create_channel", "Create a Slack channel.", { name: z.string(), is_private: z.boolean().optional(), ...profileParam },
        async ({ name, is_private, profile }) => ({ content: [{ type: "text", text: json(await slack.createChannel(getSlackAuth(profile), name, is_private)) }] }));
    s.tool("slack_archive_channel", "Archive a Slack channel.", { channel: z.string(), ...profileParam },
        async ({ channel, profile }) => { await slack.archiveChannel(getSlackAuth(profile), channel); return { content: [{ type: "text", text: "Archived." }] }; });
    s.tool("slack_invite", "Invite users to a channel.", { channel: z.string(), user_ids: z.array(z.string()), ...profileParam },
        async ({ channel, user_ids, profile }) => { await slack.inviteToChannel(getSlackAuth(profile), channel, user_ids); return { content: [{ type: "text", text: "Invited." }] }; });
    s.tool("slack_kick", "Remove a user from a channel.", { channel: z.string(), user_id: z.string(), ...profileParam },
        async ({ channel, user_id, profile }) => { await slack.kickFromChannel(getSlackAuth(profile), channel, user_id); return { content: [{ type: "text", text: "Removed." }] }; });
    s.tool("slack_set_topic", "Set a channel's topic.", { channel: z.string(), topic: z.string(), ...profileParam },
        async ({ channel, topic, profile }) => { await slack.setChannelTopic(getSlackAuth(profile), channel, topic); return { content: [{ type: "text", text: "Topic set." }] }; });
    s.tool("slack_set_purpose", "Set a channel's purpose.", { channel: z.string(), purpose: z.string(), ...profileParam },
        async ({ channel, purpose, profile }) => { await slack.setChannelPurpose(getSlackAuth(profile), channel, purpose); return { content: [{ type: "text", text: "Purpose set." }] }; });
    s.tool("slack_pin", "Pin a message.", { channel: z.string(), timestamp: z.string(), ...profileParam },
        async ({ channel, timestamp, profile }) => { await slack.pinMessage(getSlackAuth(profile), channel, timestamp); return { content: [{ type: "text", text: "Pinned." }] }; });
    s.tool("slack_unpin", "Unpin a message.", { channel: z.string(), timestamp: z.string(), ...profileParam },
        async ({ channel, timestamp, profile }) => { await slack.unpinMessage(getSlackAuth(profile), channel, timestamp); return { content: [{ type: "text", text: "Unpinned." }] }; });
    s.tool("slack_pins", "List pinned messages in a channel.", { channel: z.string(), ...profileParam },
        async ({ channel, profile }) => ({ content: [{ type: "text", text: json(await slack.listPins(getSlackAuth(profile), channel)) }] }));

    // Gmail
    s.tool("gmail_connect", "Connect a Gmail account via OAuth. Opens Google sign-in in the browser.",
        { profile: z.string().optional().describe("Account name (e.g. 'personal', 'work'). Omit for default.") },
        async ({ profile }) => {
            const authUrl = `http://127.0.0.1:${httpPort}/gmail/auth${profile ? `?profile=${profile}` : ""}`;
            try { await browserCommand("navigate", { url: authUrl }); } catch {}
            const storageKey = profileKey("gmail", profile);
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 2000));
                const creds = memCredentials.get(storageKey);
                if (creds?.refresh_token) {
                    const label = profile ? ` as "${profile}"` : "";
                    return { content: [{ type: "text", text: `Gmail connected${label}${creds.email ? ` (${creds.email})` : ""}.` }] };
                }
            }
            return { content: [{ type: "text", text: `Timed out. Visit ${authUrl} manually.` }] };
        });
    s.tool("gmail_profile", "Get Gmail profile info.", { ...profileParam },
        async ({ profile }) => ({ content: [{ type: "text", text: json(await gmail.getProfile(await getGmailAuth(profile))) }] }));
    s.tool("gmail_inbox", "Read your Gmail inbox.", { query: z.string().optional(), max_results: z.number().optional(), page_token: z.string().optional(), ...profileParam },
        async ({ query, max_results, page_token, profile }) => ({ content: [{ type: "text", text: json(await gmail.getInbox(await getGmailAuth(profile), { query, maxResults: max_results || 20, pageToken: page_token })) }] }));
    s.tool("gmail_search", "Search Gmail messages.", { query: z.string(), max_results: z.number().optional(), page_token: z.string().optional(), ...profileParam },
        async ({ query, max_results, page_token, profile }) => ({ content: [{ type: "text", text: json(await gmail.searchMail(await getGmailAuth(profile), query, max_results || 20, page_token)) }] }));
    s.tool("gmail_read", "Read a specific email.", { message_id: z.string(), ...profileParam },
        async ({ message_id, profile }) => ({ content: [{ type: "text", text: json(await gmail.getMessage(await getGmailAuth(profile), message_id)) }] }));
    s.tool("gmail_thread", "Read an entire email thread.", { thread_id: z.string(), ...profileParam },
        async ({ thread_id, profile }) => ({ content: [{ type: "text", text: json(await gmail.getThread(await getGmailAuth(profile), thread_id)) }] }));
    s.tool("gmail_send", "Send an email.", { to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional(), bcc: z.string().optional(), thread_id: z.string().optional(), ...profileParam },
        async ({ to, subject, body, cc, bcc, thread_id, profile }) => ({ content: [{ type: "text", text: json(await gmail.sendEmail(await getGmailAuth(profile), to, subject, body, { cc, bcc, threadId: thread_id })) }] }));
    s.tool("gmail_reply", "Reply to the last message in a thread.", { thread_id: z.string(), body: z.string(), ...profileParam },
        async ({ thread_id, body, profile }) => ({ content: [{ type: "text", text: json(await gmail.replyToThread(await getGmailAuth(profile), thread_id, body)) }] }));
    s.tool("gmail_draft", "Create a draft email.", { to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional(), bcc: z.string().optional(), thread_id: z.string().optional(), ...profileParam },
        async ({ to, subject, body, cc, bcc, thread_id, profile }) => ({ content: [{ type: "text", text: json(await gmail.createDraft(await getGmailAuth(profile), to, subject, body, { cc, bcc, threadId: thread_id })) }] }));
    s.tool("gmail_mark_read", "Mark an email as read.", { message_id: z.string(), ...profileParam },
        async ({ message_id, profile }) => { await gmail.markAsRead(await getGmailAuth(profile), message_id); return { content: [{ type: "text", text: "Marked as read." }] }; });
    s.tool("gmail_archive", "Archive an email.", { message_id: z.string(), ...profileParam },
        async ({ message_id, profile }) => { await gmail.archiveMessage(await getGmailAuth(profile), message_id); return { content: [{ type: "text", text: "Archived." }] }; });
    s.tool("gmail_trash", "Move an email to trash.", { message_id: z.string(), ...profileParam },
        async ({ message_id, profile }) => { await gmail.trashMessage(await getGmailAuth(profile), message_id); return { content: [{ type: "text", text: "Trashed." }] }; });
    s.tool("gmail_star", "Star an email.", { message_id: z.string(), ...profileParam },
        async ({ message_id, profile }) => { await gmail.starMessage(await getGmailAuth(profile), message_id); return { content: [{ type: "text", text: "Starred." }] }; });
    s.tool("gmail_labels", "List all Gmail labels.", { ...profileParam },
        async ({ profile }) => ({ content: [{ type: "text", text: json(await gmail.listLabels(await getGmailAuth(profile))) }] }));
    s.tool("gmail_label_create", "Create a Gmail label.", { name: z.string(), ...profileParam },
        async ({ name, profile }) => ({ content: [{ type: "text", text: json(await gmail.createLabel(await getGmailAuth(profile), name)) }] }));
    s.tool("gmail_modify", "Add or remove labels from a message.", { message_id: z.string(), add_labels: z.array(z.string()).optional(), remove_labels: z.array(z.string()).optional(), ...profileParam },
        async ({ message_id, add_labels, remove_labels, profile }) => { await gmail.modifyMessage(await getGmailAuth(profile), message_id, add_labels || [], remove_labels || []); return { content: [{ type: "text", text: "Labels modified." }] }; });

    // Collections
    s.tool("collection_create", "Create a new data collection.", {
        name: z.string(), description: z.string(),
        columns: z.array(z.object({ name: z.string(), type: z.enum(["text", "number", "boolean", "date", "json"]), description: z.string().optional() })),
    }, async ({ name, description, columns }) => ({ content: [{ type: "text", text: json(db.createCollection(name, description, columns)) }] }));
    s.tool("collection_insert", "Insert a row into a collection.", { collection: z.string(), data: z.record(z.string(), z.any()) },
        async ({ collection, data }) => ({ content: [{ type: "text", text: json(db.collectionInsert(collection, data)) }] }));
    s.tool("collection_query", "Query a collection.", {
        collection: z.string(), search: z.string().optional(), where: z.record(z.string(), z.any()).optional(),
        order_by: z.string().optional(), limit: z.number().optional(), offset: z.number().optional(),
    }, async ({ collection, search, where, order_by, limit, offset }) => ({ content: [{ type: "text", text: json(db.collectionQuery(collection, { search, where, orderBy: order_by, limit, offset })) }] }));
    s.tool("collection_list", "List all collections.", {}, async () => {
        const collections = db.listCollections();
        return { content: [{ type: "text", text: collections.length === 0 ? "No collections yet." : json(collections) }] };
    });
    s.tool("collection_update", "Update a row in a collection by ID.", { collection: z.string(), id: z.number(), data: z.record(z.string(), z.any()) },
        async ({ collection, id, data }) => ({ content: [{ type: "text", text: db.collectionUpdate(collection, id, data) ? "Updated." : "Row not found." }] }));
    s.tool("collection_delete", "Delete a row from a collection by ID.", { collection: z.string(), id: z.number() },
        async ({ collection, id }) => ({ content: [{ type: "text", text: db.collectionDelete(collection, id) ? "Deleted." : "Row not found." }] }));

    // Credentials
    s.tool("list_credentials", "List all stored service credentials (keys only).", {},
        async () => ({ content: [{ type: "text", text: json(db.listConnectedServices()) }] }));
    s.tool("store_credential", "Manually store a credential for a service.", { service: z.string(), key: z.string(), value: z.string() },
        async ({ service, key, value }) => { db.storeCredential(service, key, value); return { content: [{ type: "text", text: `Stored ${key} for ${service}.` }] }; });
    s.tool("list_profiles", "List all stored profiles for a service.", { service: z.string().describe("Service name, e.g. 'linkedin' or 'twitter'") },
        async ({ service }) => {
            const profiles = db.listProfiles(service);
            return { content: [{ type: "text", text: profiles.length === 0 ? `No credentials stored for "${service}".` : json(profiles) }] };
        });

    // Analytics
    s.tool("content_monitor", "Fetch analytics on your recent posts for a service. For Twitter, pass your screen_name.", { service: z.enum(["linkedin", "twitter"]), screen_name: z.string().optional().describe("Your Twitter handle (required for twitter)"), count: z.number().optional(), ...profileParam },
        async ({ service, screen_name, count, profile }) => {
            if (service === "twitter" && !screen_name) return { content: [{ type: "text", text: "screen_name is required for twitter." }] };
            const posts = service === "linkedin"
                ? await linkedin.getMyPosts(getLinkedInAuth(profile), count || 20)
                : await twitter.getUserTweets(getTwitterAuth(profile), screen_name!, count || 20);
            const items = Array.isArray(posts) ? posts : [];
            if (items.length === 0) return { content: [{ type: "text", text: "No posts found." }] };
            const metrics = items.map((p: any) => ({ id: p.id || p.tweet_id, text: (p.text || p.content || "").slice(0, 120), likes: Number(p.likes || p.like_count || 0), comments: Number(p.comments || p.comment_count || p.reply_count || 0), shares: Number(p.shares || p.reposts || p.repost_count || p.retweet_count || 0), impressions: Number(p.impressions || p.impression_count || 0), posted_at: p.created_at || p.postedAt || "" }));
            const totalLikes = metrics.reduce((s: number, p: any) => s + p.likes, 0);
            const totalComments = metrics.reduce((s: number, p: any) => s + p.comments, 0);
            const totalShares = metrics.reduce((s: number, p: any) => s + p.shares, 0);
            const best = [...metrics].sort((a: any, b: any) => (b.likes + b.comments + b.shares) - (a.likes + a.comments + a.shares)).slice(0, 3);
            return { content: [{ type: "text", text: json({ service, profile: profile || "default", posts_analysed: metrics.length, totals: { likes: totalLikes, comments: totalComments, shares: totalShares }, averages: { likes: (totalLikes / metrics.length).toFixed(1), comments: (totalComments / metrics.length).toFixed(1), shares: (totalShares / metrics.length).toFixed(1) }, top_posts: best, all_posts: metrics }) }] };
        });
    s.tool("track_post", "Add a post to the analytics tracking collection.", { service: z.enum(["linkedin", "twitter"]), post_id: z.string(), post_url: z.string().optional(), post_text: z.string().optional(), likes: z.number().optional(), comments: z.number().optional(), shares: z.number().optional(), impressions: z.number().optional(), ...profileParam },
        async ({ service, post_id, post_url, post_text, likes, comments, shares, impressions, profile }) => {
            ensureAnalyticsCollection();
            const now = new Date().toISOString();
            const result = db.collectionInsert(ANALYTICS_COLLECTION, { service, post_id, post_url: post_url || "", post_text: (post_text || "").slice(0, 500), likes: likes || 0, comments: comments || 0, shares: shares || 0, impressions: impressions || 0, profile: profile || "default", tracked_at: now, last_checked_at: now });
            return { content: [{ type: "text", text: `Tracking post ${post_id} (id=${result.id}).` }] };
        });
    s.tool("analytics_report", "Generate a summary report of all tracked posts' performance.", { service: z.enum(["linkedin", "twitter"]).optional(), ...profileParam },
        async ({ service, profile }) => {
            ensureAnalyticsCollection();
            const where: Record<string, any> = {};
            if (service) where.service = service;
            if (profile) where.profile = profile;
            const rows = db.collectionQuery(ANALYTICS_COLLECTION, { where: Object.keys(where).length ? where : undefined, limit: 500, orderBy: "created_at DESC" });
            if (rows.length === 0) return { content: [{ type: "text", text: "No tracked posts yet. Use track_post to start monitoring." }] };
            const byService: Record<string, any[]> = {};
            for (const row of rows) { if (!byService[row.service]) byService[row.service] = []; byService[row.service].push(row); }
            const summary: Record<string, any> = {};
            for (const [svc, posts] of Object.entries(byService)) {
                const tl = posts.reduce((s, p) => s + (p.likes || 0), 0), tc = posts.reduce((s, p) => s + (p.comments || 0), 0), ts = posts.reduce((s, p) => s + (p.shares || 0), 0);
                summary[svc] = { tracked_posts: posts.length, totals: { likes: tl, comments: tc, shares: ts }, averages: { likes: (tl / posts.length).toFixed(1), comments: (tc / posts.length).toFixed(1), shares: (ts / posts.length).toFixed(1) }, top_posts: [...posts].sort((a, b) => (b.likes + b.comments + b.shares) - (a.likes + a.comments + a.shares)).slice(0, 3).map((p) => ({ id: p.post_id, text: p.post_text, likes: p.likes, comments: p.comments, shares: p.shares, tracked_at: p.tracked_at })) };
            }
            return { content: [{ type: "text", text: json({ generated_at: new Date().toISOString(), filter: { service, profile }, ...summary }) }] };
        });

    // Cross-Platform Content Repurposer
    s.tool("repurpose_content", "Repurpose content between LinkedIn and Twitter. Adapts formatting, length, tone, and hashtags.", {
        text: z.string(), from: z.enum(["linkedin", "twitter"]), to: z.enum(["linkedin", "twitter"]),
        tone: z.enum(["professional", "casual", "thought_leader", "storytelling"]).optional(),
        include_hashtags: z.boolean().optional(),
    }, async ({ text, from, to, tone, include_hashtags }) => {
        if (from === to) return { content: [{ type: "text", text: "Source and target are the same." }] };
        const hashtagsEnabled = include_hashtags !== false;
        const result: any = { original: { platform: from, text, char_count: text.length }, repurposed: { platform: to } };
        if (from === "linkedin" && to === "twitter") {
            const sentences = text.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/).filter(s => s.trim());
            let tweet = (sentences[0] || text.slice(0, 275)).replace(/^[🔹🔸▶️➡️•\-\d+.]\s*/gm, "").replace(/#\w+\s*/g, "").replace(/\s+/g, " ").trim();
            if (tweet.length > 280) tweet = tweet.slice(0, 275) + "...";
            const threadTweets: string[] = []; let cur = "";
            for (const s of sentences) { const c = s.replace(/#\w+\s*/g, "").trim(); if (!c) continue; if ((cur + " " + c).trim().length <= 270) { cur = (cur + " " + c).trim(); } else { if (cur) threadTweets.push(cur); cur = c.length > 270 ? c.slice(0, 267) + "..." : c; } }
            if (cur) threadTweets.push(cur);
            if (hashtagsEnabled) { const tags = extractHashtags(text, "twitter"); if (tags.length > 0) { const ts = " " + tags.slice(0, 3).join(" "); if (tweet.length + ts.length <= 280) tweet += ts; } }
            result.repurposed.single_tweet = { text: tweet, char_count: tweet.length };
            if (threadTweets.length > 1) result.repurposed.thread = threadTweets.map((t, i) => ({ tweet_number: i + 1, text: `${i + 1}/${threadTweets.length} ${t}`, char_count: t.length }));
        } else {
            const clean = text.replace(/@\w+/g, "").replace(/https?:\/\/\S+/g, "").trim();
            const t = tone || "professional";
            let post = t === "thought_leader" ? `${clean}\n\nHere's what most people miss about this:\n\nWhat's your take?`
                : t === "storytelling" ? `Something caught my attention today.\n\n${clean}\n\nThe lesson? Sometimes the simplest observations lead to the deepest insights.`
                : t === "casual" ? `${clean}\n\nThoughts? 👇`
                : `${clean}\n\nThis is an important point that deserves more attention.\n\nWhat are your thoughts?`;
            if (hashtagsEnabled) { const tags = extractHashtags(text, "linkedin"); if (tags.length > 0) post += "\n\n" + tags.slice(0, 5).join(" "); }
            result.repurposed.post = { text: post, char_count: post.length };
            result.repurposed.tone = t;
        }
        return { content: [{ type: "text", text: json(result) }] };
    });

    // Cross-Platform Workflows
    s.tool("meeting_prep", "Prepare for a meeting by pulling LinkedIn profiles of all attendees from a Google Calendar event.", {
        event_id: z.string(), calendar_id: z.string().optional(), gcal_profile: z.string().optional(), linkedin_profile: z.string().optional(),
    }, async ({ event_id, calendar_id, gcal_profile, linkedin_profile }) => {
        const calAuth = await getGCalAuth(gcal_profile);
        const event = await gcal.getEvent(calAuth, calendar_id || "primary", event_id);
        const attendees = event.attendees || [];
        if (attendees.length === 0) return { content: [{ type: "text", text: json({ event: { summary: event.summary, start: event.start }, attendees: [], note: "No attendees." }) }] };
        const liAuth = getLinkedInAuth(linkedin_profile);
        const profiles: any[] = [];
        for (const a of attendees) {
            const name = a.displayName || (a.email || "").split("@")[0];
            const p: any = { email: a.email, name, responseStatus: a.responseStatus };
            if (name && name !== a.email) { try { const r = await linkedin.searchPeople(liAuth, name, 3); if (r.length > 0) p.linkedin = { name: `${r[0].firstName || ""} ${r[0].lastName || ""}`.trim(), headline: r[0].headline, profileUrl: r[0].publicId ? `https://linkedin.com/in/${r[0].publicId}` : null }; } catch {} }
            profiles.push(p);
        }
        return { content: [{ type: "text", text: json({ event: { summary: event.summary, start: event.start, end: event.end, location: event.location }, attendee_count: profiles.length, attendees: profiles }) }] };
    });
    s.tool("smart_inbox", "Unified notification inbox across all connected platforms.", { github_profile: z.string().optional(), linkedin_profile: z.string().optional(), gcal_profile: z.string().optional(), gmail_profile: z.string().optional() },
        async ({ github_profile, linkedin_profile, gcal_profile, gmail_profile }) => {
            const inbox: any = { timestamp: new Date().toISOString(), sections: {} };
            try { const ghAuth = getGitHubAuth(github_profile); const n = await github.getNotifications(ghAuth, 10, false); inbox.sections.github = { count: n.length, items: n.map((i: any) => ({ title: i.subject?.title, type: i.subject?.type, repo: i.repository?.full_name, reason: i.reason })) }; } catch (e: any) { inbox.sections.github = { error: e.message }; }
            try { const liAuth = getLinkedInAuth(linkedin_profile); const c = await linkedin.getConversations(liAuth, 5); const u = (c.conversations || []).filter((x: any) => x.unreadCount > 0); inbox.sections.linkedin = { unread: u.length, items: u.map((x: any) => ({ from: x.participants?.map((p: any) => p.name).join(", "), preview: x.lastMessage?.slice(0, 100) })) }; } catch (e: any) { inbox.sections.linkedin = { error: e.message }; }
            try { const calAuth = await getGCalAuth(gcal_profile); const now = new Date(); const eod = new Date(now); eod.setHours(23,59,59); const ev = await gcal.listEvents(calAuth, "primary", { timeMin: now.toISOString(), timeMax: eod.toISOString(), maxResults: 5 }); inbox.sections.calendar = { remaining_today: ev.length, items: ev.map((e: any) => ({ summary: e.summary, start: e.start?.dateTime || e.start?.date })) }; } catch (e: any) { inbox.sections.calendar = { error: e.message }; }
            try { const gmAuth = await getGmailAuth(gmail_profile); const r = await gmail.listMessages(gmAuth, { query: "is:unread", maxResults: 10 }); const msgs = r.messages || []; inbox.sections.gmail = { unread: msgs.length, items: msgs.map((m: any) => ({ from: m.from, subject: m.subject, snippet: m.snippet })) }; } catch (e: any) { inbox.sections.gmail = { error: e.message }; }
            return { content: [{ type: "text", text: json(inbox) }] };
        });
    s.tool("contact_enrich", "Enrich a contact by searching across LinkedIn, Twitter, GitHub, and Notion.", { name: z.string().optional(), email: z.string().optional(), linkedin_profile: z.string().optional() },
        async ({ name, email, linkedin_profile }) => {
            if (!name && !email) return { content: [{ type: "text", text: "Provide a name or email." }] };
            const q = name || (email ? email.split("@")[0].replace(/[._]/g, " ") : "");
            const r: any = { query: { name, email }, profiles: {} };
            try { const liAuth = getLinkedInAuth(linkedin_profile); const p = await linkedin.searchPeople(liAuth, q, 5); r.profiles.linkedin = p.map((x: any) => ({ name: `${x.firstName || ""} ${x.lastName || ""}`.trim(), headline: x.headline, location: x.location, url: x.publicId ? `https://linkedin.com/in/${x.publicId}` : null })); } catch (e: any) { r.profiles.linkedin = { error: e.message }; }
            try { const ghAuth = getGitHubAuth(); const u = await github.searchUsers(ghAuth, q, 5); r.profiles.github = u.map((x: any) => ({ login: x.login, html_url: x.html_url })); } catch (e: any) { r.profiles.github = { error: e.message }; }
            try { const nAuth = getNotionAuth(); const p = await notion.search(nAuth, q, { limit: 3 }); if (p.length > 0) r.profiles.notion = p.map((x: any) => ({ title: x.title, url: x.url })); } catch {}
            return { content: [{ type: "text", text: json(r) }] };
        });
    s.tool("content_calendar", "Manage a cross-platform content calendar.", {
        action: z.enum(["create_draft", "list_drafts", "schedule", "list_scheduled", "mark_published"]),
        text: z.string().optional(), platform: z.enum(["linkedin", "twitter", "both"]).optional(),
        draft_id: z.number().optional(), schedule_time: z.string().optional(), gcal_profile: z.string().optional(),
    }, async ({ action, text, platform, draft_id, schedule_time, gcal_profile }) => {
        const cn = "content_calendar";
        try { await db.createCollection(cn, "Content calendar", [{ name: "text", type: "text" }, { name: "platform", type: "text" }, { name: "status", type: "text" }, { name: "scheduled_at", type: "text" }, { name: "published_at", type: "text" }, { name: "cal_event_id", type: "text" }]); } catch {}
        if (action === "create_draft") { if (!text) return { content: [{ type: "text", text: "Provide text." }] }; const { id } = db.collectionInsert(cn, { text, platform: platform || "both", status: "draft", scheduled_at: "", published_at: "", cal_event_id: "" }); return { content: [{ type: "text", text: json({ id, status: "draft" }) }] }; }
        if (action === "list_drafts") return { content: [{ type: "text", text: json(db.collectionQuery(cn, { where: { status: "draft" } })) }] };
        if (action === "schedule") { if (!draft_id || !schedule_time) return { content: [{ type: "text", text: "Provide draft_id and schedule_time." }] }; db.collectionUpdate(cn, draft_id, { status: "scheduled", scheduled_at: schedule_time }); return { content: [{ type: "text", text: json({ draft_id, status: "scheduled", scheduled_at: schedule_time }) }] }; }
        if (action === "list_scheduled") return { content: [{ type: "text", text: json(db.collectionQuery(cn, { where: { status: "scheduled" } })) }] };
        if (action === "mark_published") { if (!draft_id) return { content: [{ type: "text", text: "Provide draft_id." }] }; db.collectionUpdate(cn, draft_id, { status: "published", published_at: new Date().toISOString() }); return { content: [{ type: "text", text: json({ draft_id, status: "published" }) }] }; }
        return { content: [{ type: "text", text: "Unknown action." }] };
    });
    s.tool("pr_digest", "Get a GitHub PR digest: open PRs, review requests, failing CI.", {
        github_profile: z.string().optional(), slack_profile: z.string().optional(), slack_channel: z.string().optional(), repos: z.array(z.string()).optional(),
    }, async ({ github_profile, slack_profile, slack_channel, repos }) => {
        const ghAuth = getGitHubAuth(github_profile);
        const digest: any = { timestamp: new Date().toISOString(), sections: {} };
        let repoList = repos || [];
        if (repoList.length === 0) { try { const r = await github.listMyRepos(ghAuth, 10, "pushed"); repoList = r.map((x: any) => x.name); } catch {} }
        try { const n = await github.getNotifications(ghAuth, 20, false); const prn = n.filter((x: any) => x.subject?.type === "PullRequest"); digest.sections.review_requests = { count: prn.length, items: prn.slice(0, 10).map((x: any) => ({ title: x.subject?.title, repo: x.repository?.full_name, reason: x.reason })) }; } catch (e: any) { digest.sections.review_requests = { error: e.message }; }
        const allPRs: any[] = [];
        for (const repo of repoList.slice(0, 5)) { const [o, n] = repo.includes("/") ? repo.split("/") : ["", repo]; try { const on = o || (await github.getAuthenticatedUser(ghAuth)).login; const prs = await github.listPRs(ghAuth, on, n, { state: "open", count: 10 }); for (const pr of prs) allPRs.push({ repo: `${on}/${n}`, number: pr.number, title: pr.title, author: pr.user?.login, draft: pr.draft }); } catch {} }
        digest.sections.open_prs = { count: allPRs.length, items: allPRs };
        if (slack_channel) { try { const sa = getSlackAuth(slack_profile); const lines = [`*🔔 PR Digest*\n*Open PRs (${allPRs.length}):*`]; for (const pr of allPRs.slice(0, 5)) lines.push(`• ${pr.repo}#${pr.number}: ${pr.title}`); await slack.postMessage(sa, slack_channel, lines.join("\n")); digest.slack_posted = true; } catch (e: any) { digest.slack_error = e.message; } }
        return { content: [{ type: "text", text: json(digest) }] };
    });

    // Dynamic tools
    s.tool("create_tool", "Create a new MCP tool that persists across restarts.", {
        name: z.string(), description: z.string(),
        params_schema: z.record(z.string(), z.string()),
        code: z.string(), service: z.string().optional(),
    }, async ({ name, description, params_schema, code, service }) => {
        db.saveCustomTool(name, description, params_schema, code, service);
        registerDynamicTool(name, description, params_schema, code);
        await server.server.sendToolListChanged();
        return { content: [{ type: "text", text: `Tool "${name}" created and registered.` }] };
    });
    s.tool("discover_api", "Discover a website's internal API by navigating and capturing network requests.", {
        url: z.string().describe("URL to navigate to"),
        service: z.string().optional().describe("Service name for auth (auto-detected from URL if omitted)"),
        filters: z.array(z.string()).optional().describe("URL substrings to capture"),
        wait_seconds: z.number().optional().describe("Wait time for requests (default: 5s, max: 15s)"),
    }, async ({ url, service, filters, wait_seconds }) => {
        if (!isBridgeConnected()) return { content: [{ type: "text", text: "Browser extension not connected." }] };
        const results: string[] = [];
        const domain = service || new URL(url).hostname;
        results.push(`## Extracting auth from ${domain}...`);
        try {
            const authResult = await browserCommand("extract_auth", { service: domain });
            const creds: Record<string, string> = {};
            for (const [key, value] of Object.entries(authResult)) { if (key === "service" || !value || typeof value !== "string") continue; creds[key] = value as string; try { db.storeCredential(domain, key, value as string); } catch {} }
            if (Array.isArray(authResult.cookies) && authResult.cookies.length > 0) { const cookieHeader = authResult.cookies.map((c: any) => `${c.name}=${c.value}`).join("; "); creds._cookies = cookieHeader; try { db.storeCredential(domain, "_cookies", cookieHeader); } catch {} }
            storeAuthInMemory(domain, creds);
            results.push(`✅ Auth extracted. Tokens: ${Object.keys(creds).filter(k => !k.startsWith("_")).join(", ") || "cookies only"}`);
        } catch (err: any) { results.push(`⚠️ Auth extraction failed: ${err.message}`); }
        results.push(`\n## Capturing network requests from ${url}...`);
        await browserCommand("network_start_capture", { filters: filters || [] });
        await browserCommand("navigate", { url });
        await new Promise(r => setTimeout(r, Math.min((wait_seconds || 5), 15) * 1000));
        const captureData = await browserCommand("network_list", { filter: undefined, limit: 200 });
        const requests = captureData?.requests || [];
        await browserCommand("network_stop_capture");
        if (requests.length === 0) { results.push("❌ No requests captured."); return { content: [{ type: "text", text: results.join("\n") }] }; }
        results.push(`✅ Captured ${requests.length} requests.\n`);
        const apiReqs = requests.filter((r: any) => { const u = (r.url || "").toLowerCase(); return !(u.endsWith(".js") || u.endsWith(".css") || u.endsWith(".png") || u.endsWith(".jpg") || u.endsWith(".svg") || u.endsWith(".woff2") || u.endsWith(".ico") || u.includes("/static/") || u.includes("/assets/")); });
        const dataReqs = apiReqs.filter((r: any) => { const u = (r.url || "").toLowerCase(); return u.includes("api") || u.includes("graphql") || u.includes("/v1/") || u.includes("/v2/") || u.includes("rpc") || (r.method && r.method !== "GET"); });
        results.push("### API Endpoints:");
        for (const r of (dataReqs.length > 0 ? dataReqs : apiReqs).slice(0, 30)) { results.push(`  [${r.id}] ${r.method || "GET"} ${r.status || "?"} ${r.url}`); }
        results.push(`\nAuth stored under "${domain}". Use network_request_detail(id) to inspect, then create_tool() to save.`);
        return { content: [{ type: "text", text: results.join("\n") }] };
    });
    s.tool("web_scrape", "Extract structured data from any URL (text, links, tables, images, meta, JSON-LD).", {
        url: z.string(), extract: z.array(z.enum(["text", "links", "tables", "images", "meta", "structured_data", "all"])).optional(), selector: z.string().optional(),
    }, async ({ url, extract, selector }) => {
        if (!isBridgeConnected()) return { content: [{ type: "text", text: "Browser not connected." }] };
        await browserCommand("navigate", { url });
        await new Promise(r => setTimeout(r, 3000));
        const extractAll = !extract || extract.includes("all");
        const w = (t: string) => extractAll || extract?.includes(t as any);
        const script = `(function(){const s=${selector?`document.querySelector(${JSON.stringify(selector)})`:'document'}||document;const r={url:location.href,title:document.title};${w("meta")?`r.meta={};const md=document.querySelector('meta[name="description"]');r.meta.description=md?md.content:'';document.querySelectorAll('meta[property^="og:"]').forEach(m=>{r.meta[m.getAttribute('property')]=m.content});`:''}${w("text")?`const ce=s.querySelector('article')||s.querySelector('main')||s.querySelector('.content')||s;const cl=ce.cloneNode(true);cl.querySelectorAll('script,style,nav,footer,header,aside').forEach(e=>e.remove());r.text=(cl.innerText||'').replace(/\\n{3,}/g,'\\n\\n').trim().slice(0,50000);r.word_count=r.text.split(/\\s+/).length;`:''}${w("links")?`const ls=[];const sn=new Set();s.querySelectorAll('a[href]').forEach(a=>{if(a.href&&!a.href.startsWith('javascript:')&&a.innerText.trim()&&!sn.has(a.href)){sn.add(a.href);ls.push({text:a.innerText.trim().slice(0,200),href:a.href})}});r.links=ls.slice(0,200);`:''}${w("tables")?`r.tables=[];s.querySelectorAll('table').forEach((t,i)=>{const rows=[];t.querySelectorAll('tr').forEach(tr=>{const c=[];tr.querySelectorAll('th,td').forEach(td=>c.push(td.innerText.trim()));if(c.length)rows.push(c)});if(rows.length)r.tables.push({headers:rows[0],rows:rows.slice(1,100)})});`:''}${w("images")?`r.images=[];s.querySelectorAll('img[src]').forEach(i=>{if(i.naturalWidth>50)r.images.push({src:i.src,alt:i.alt||'',w:i.naturalWidth,h:i.naturalHeight})});r.images=r.images.slice(0,50);`:''}${w("structured_data")?`r.structured_data=[];document.querySelectorAll('script[type="application/ld+json"]').forEach(s=>{try{r.structured_data.push(JSON.parse(s.textContent))}catch{}});`:''}return r})()`;
        try { const data = await browserCommand("execute_script", { code: script }); return { content: [{ type: "text", text: json(data) }] }; }
        catch (e: any) { try { const fb = await browserCommand("execute_script", { code: `({url:location.href,title:document.title,text:document.body.innerText.slice(0,30000)})` }); return { content: [{ type: "text", text: json({...fb, note: "Partial extraction"}) }] }; } catch { return { content: [{ type: "text", text: `Scrape failed: ${e.message}` }] }; } }
    });
    s.tool("diff_monitor", "Monitor any URL for changes. Stores snapshots, compares, reports diffs.", {
        action: z.enum(["check", "list", "history", "remove"]),
        url: z.string().optional(), name: z.string().optional(), selector: z.string().optional(), extract: z.enum(["text", "html", "json"]).optional(),
    }, async ({ action, url, name, selector, extract: ext }) => {
        const CN = "diff_monitor";
        try { db.createCollection(CN, "Page change monitoring", [{ name: "monitor_name", type: "text" },{ name: "url", type: "text" },{ name: "selector", type: "text" },{ name: "extract_type", type: "text" },{ name: "content_hash", type: "text" },{ name: "content", type: "text" },{ name: "checked_at", type: "text" },{ name: "changed", type: "boolean" },{ name: "diff_summary", type: "text" }]); } catch {}
        if (action === "list") { const all = db.collectionQuery(CN, { orderBy: "checked_at DESC", limit: 200 }) as any[]; const m = new Map<string,any>(); for (const r of all) { if (!m.has(r.monitor_name)) m.set(r.monitor_name, { name: r.monitor_name, url: r.url, last_checked: r.checked_at, snapshots: 0 }); m.get(r.monitor_name).snapshots++; } return { content: [{ type: "text", text: json([...m.values()]) }] }; }
        if (action === "history") { if (!name) return { content: [{ type: "text", text: "Provide name." }] }; const s = db.collectionQuery(CN, { where: { monitor_name: name }, orderBy: "checked_at DESC", limit: 20 }) as any[]; return { content: [{ type: "text", text: json(s.map(x => ({ checked_at: x.checked_at, changed: x.changed, diff: x.diff_summary, preview: (x.content||"").slice(0,200) }))) }] }; }
        if (action === "remove") { if (!name) return { content: [{ type: "text", text: "Provide name." }] }; const rows = db.collectionQuery(CN, { where: { monitor_name: name } }) as any[]; for (const r of rows) { try { db.collectionDelete(CN, r.id); } catch {} } return { content: [{ type: "text", text: `Removed "${name}" (${rows.length} snapshots).` }] }; }
        if (!url) return { content: [{ type: "text", text: "Provide URL." }] };
        const mn = name || new URL(url).hostname + new URL(url).pathname;
        let content = "";
        try {
            if ((ext || "text") === "json") { const r = await browserCommand("browser_fetch", { url, method: "GET", credentials: "include" }); content = typeof r.body === "string" ? r.body : JSON.stringify(r.body); }
            else { await browserCommand("navigate", { url }); await new Promise(r => setTimeout(r, 3000)); const sc = selector ? `(document.querySelector(${JSON.stringify(selector)})||document.body).${ext==="html"?"innerHTML":"innerText"}` : `document.body.${ext==="html"?"innerHTML":"innerText"}`; content = (await browserCommand("execute_script", { code: sc })) || ""; if (typeof content !== "string") content = JSON.stringify(content); }
        } catch (e: any) { return { content: [{ type: "text", text: `Fetch failed: ${e.message}` }] }; }
        let h = 0; for (let i = 0; i < content.length; i++) h = ((h << 5) - h + content.charCodeAt(i)) | 0;
        const ch = h.toString(36);
        const prev = (db.collectionQuery(CN, { where: { monitor_name: mn }, orderBy: "checked_at DESC", limit: 1 }) as any[])[0];
        let changed = true, diff = "First snapshot — baseline.";
        if (prev) { changed = prev.content_hash !== ch; diff = changed ? "Content changed." : "No changes."; }
        db.collectionInsert(CN, { monitor_name: mn, url, selector: selector||"", extract_type: ext||"text", content_hash: ch, content: content.slice(0, 50000), checked_at: new Date().toISOString(), changed, diff_summary: diff });
        return { content: [{ type: "text", text: json({ monitor: mn, url, changed, diff, preview: content.slice(0, 500), checked_at: new Date().toISOString() }) }] };
    });
    s.tool("list_custom_tools", "List all custom tools.", {}, async () => {
        const tools = db.getCustomTools();
        if (tools.length === 0) return { content: [{ type: "text", text: "No custom tools created yet." }] };
        const lines = tools.map((t: any) => `${t.name} (${t.service || "general"}) — ${t.description}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
    });
    s.tool("get_tool_code", "View a custom tool's implementation.", { name: z.string() },
        async ({ name }) => { const tool = db.getCustomTool(name); return { content: [{ type: "text", text: tool ? `// ${tool.name}: ${tool.description}\n// params: ${tool.params_schema}\n\n${tool.code}` : `Tool "${name}" not found.` }] }; });
    s.tool("delete_tool", "Delete a custom tool.", { name: z.string() },
        async ({ name }) => { const deleted = db.deleteCustomTool(name); if (deleted) await server.server.sendToolListChanged(); return { content: [{ type: "text", text: deleted ? `Deleted "${name}".` : `Tool "${name}" not found.` }] }; });

    // WhatsApp
    s.tool("whatsapp_connect", "Connect to WhatsApp. Opens a QR code in the browser on first use. Auto-reconnects after that.", {},
        async () => {
            const wa = await import("./integrations/whatsapp.js");
            const { state } = wa.getConnectionState();
            if (state === "connected") return { content: [{ type: "text", text: "WhatsApp already connected." }] };

            // Start connecting (non-blocking — triggers QR generation)
            wa.connect().catch(() => {});

            // Wait briefly for QR or connection
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
                const s = wa.getConnectionState();
                if (s.state === "connected") return { content: [{ type: "text", text: "WhatsApp connected." }] };
                if (s.state === "qr" && s.qr) {
                    // Open QR page in browser via extension
                    const qrUrl = `http://127.0.0.1:${httpPort}/whatsapp-qr`;
                    try { await browserCommand("navigate", { url: qrUrl }); } catch {}
                    // Now wait for the user to scan (up to 60s)
                    const scanDeadline = Date.now() + 60000;
                    while (Date.now() < scanDeadline) {
                        await new Promise(r => setTimeout(r, 2000));
                        if (wa.getConnectionState().state === "connected") {
                            return { content: [{ type: "text", text: "WhatsApp connected! QR code scanned successfully." }] };
                        }
                    }
                    return { content: [{ type: "text", text: `QR code opened in browser at ${qrUrl}. Scan it with WhatsApp (Linked Devices > Link a Device), then call whatsapp_connect again.` }] };
                }
                await new Promise(r => setTimeout(r, 500));
            }
            return { content: [{ type: "text", text: `WhatsApp connection state: ${wa.getConnectionState().state}. Try again.` }] };
        });
    s.tool("whatsapp_chats", "List WhatsApp chats with last message and unread count.", { limit: z.number().optional() },
        async ({ limit }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getChats(limit || 30)) }] }; });
    s.tool("whatsapp_search_chats", "Search WhatsApp chats by name.", { query: z.string(), limit: z.number().optional() },
        async ({ query, limit }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.searchChats(query, limit || 20)) }] }; });
    s.tool("whatsapp_read", "Read messages from a WhatsApp chat with pagination and search.",
        { chat: z.string().describe("Chat ID, phone number, or contact name"), limit: z.number().optional(), offset: z.number().optional().describe("Skip N most recent messages"), query: z.string().optional().describe("Filter messages containing this text"), before: z.number().optional().describe("Unix timestamp cursor — only messages before this time") },
        async ({ chat, limit, offset, query, before }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.readMessages(chat, { limit: limit || 30, offset, query, before })) }] }; });
    s.tool("whatsapp_search", "Search messages across all WhatsApp chats by text content.",
        { query: z.string(), chat: z.string().optional().describe("Limit search to a specific chat"), limit: z.number().optional() },
        async ({ query, chat, limit }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.searchMessages(query, { chatId: chat, limit: limit || 30 })) }] }; });
    s.tool("whatsapp_send", "Send a WhatsApp text message.", { to: z.string().describe("Phone number, contact name, or chat ID"), text: z.string() },
        async ({ to, text }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.sendMessage(to, text)) }] }; });
    s.tool("whatsapp_send_media", "Send media (image, video, document, audio, sticker) on WhatsApp.",
        { to: z.string(), type: z.enum(["image", "video", "document", "audio", "sticker"]), url: z.string().describe("File URL or local path"), caption: z.string().optional(), filename: z.string().optional(), mimetype: z.string().optional() },
        async ({ to, type, url, caption, filename, mimetype }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.sendMedia(to, { type, url, caption, filename, mimetype })) }] }; });
    s.tool("whatsapp_send_location", "Send a location on WhatsApp.", { to: z.string(), latitude: z.number(), longitude: z.number(), name: z.string().optional() },
        async ({ to, latitude, longitude, name }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.sendLocation(to, latitude, longitude, name)) }] }; });
    s.tool("whatsapp_send_contact", "Send a contact card on WhatsApp.", { to: z.string(), contact_name: z.string(), contact_phone: z.string().describe("Phone number without + prefix") },
        async ({ to, contact_name, contact_phone }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.sendContact(to, contact_name, contact_phone)) }] }; });
    s.tool("whatsapp_check_number", "Check if a phone number is on WhatsApp.", { phone: z.string() },
        async ({ phone }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.checkOnWhatsApp(phone)) }] }; });
    s.tool("whatsapp_find_contact", "Search contacts by name or phone number.", { query: z.string() },
        async ({ query }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.findContact(query)) }] }; });
    s.tool("whatsapp_profile_pic", "Get profile picture URL for a contact or group.", { chat: z.string() },
        async ({ chat }) => { const wa = await import("./integrations/whatsapp.js"); const url = await wa.getProfilePicUrl(chat); return { content: [{ type: "text", text: url || "No profile picture." }] }; });
    s.tool("whatsapp_status", "Get a contact's status/bio.", { chat: z.string() },
        async ({ chat }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getStatus(chat)) }] }; });
    s.tool("whatsapp_update_status", "Update your WhatsApp status/bio.", { status: z.string() },
        async ({ status }) => { const wa = await import("./integrations/whatsapp.js"); await wa.updateMyStatus(status); return { content: [{ type: "text", text: "Status updated." }] }; });
    s.tool("whatsapp_presence", "Send presence update (typing indicator, online, etc.).",
        { type: z.enum(["available", "unavailable", "composing", "paused", "recording"]), chat: z.string().optional().describe("Chat to show typing in") },
        async ({ type, chat }) => { const wa = await import("./integrations/whatsapp.js"); await wa.sendPresence(type, chat); return { content: [{ type: "text", text: `Presence set to ${type}.` }] }; });
    s.tool("whatsapp_add_contact", "Create or update a contact.", { phone: z.string(), name: z.string() },
        async ({ phone, name }) => { const wa = await import("./integrations/whatsapp.js"); await wa.addOrEditContact(phone, name); return { content: [{ type: "text", text: `Contact ${name} saved.` }] }; });
    s.tool("whatsapp_chat_modify", "Archive, unarchive, mute, unmute, pin, or unpin a chat.",
        { chat: z.string(), action: z.enum(["archive", "unarchive", "mute", "unmute", "pin", "unpin"]) },
        async ({ chat, action }) => { const wa = await import("./integrations/whatsapp.js"); await wa.modifyChat(chat, action); return { content: [{ type: "text", text: `Chat ${action}d.` }] }; });
    s.tool("whatsapp_star", "Star or unstar messages.", { chat: z.string(), message_ids: z.array(z.string()), star: z.boolean() },
        async ({ chat, message_ids, star }) => { const wa = await import("./integrations/whatsapp.js"); await wa.starMessages(chat, message_ids, star); return { content: [{ type: "text", text: star ? "Messages starred." : "Messages unstarred." }] }; });
    s.tool("whatsapp_mark_read", "Mark a chat as read.", { chat: z.string() },
        async ({ chat }) => { const wa = await import("./integrations/whatsapp.js"); await wa.markRead(chat); return { content: [{ type: "text", text: "Marked as read." }] }; });
    s.tool("whatsapp_block", "Block a contact.", { chat: z.string() },
        async ({ chat }) => { const wa = await import("./integrations/whatsapp.js"); await wa.blockContact(chat); return { content: [{ type: "text", text: "Blocked." }] }; });
    s.tool("whatsapp_unblock", "Unblock a contact.", { chat: z.string() },
        async ({ chat }) => { const wa = await import("./integrations/whatsapp.js"); await wa.unblockContact(chat); return { content: [{ type: "text", text: "Unblocked." }] }; });
    s.tool("whatsapp_blocklist", "List all blocked contacts.", {},
        async () => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getBlocklist()) }] }; });
    s.tool("whatsapp_group_info", "Get group metadata (members, description, settings).", { group: z.string() },
        async ({ group }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getGroupMetadata(group)) }] }; });
    s.tool("whatsapp_group_create", "Create a new WhatsApp group.", { name: z.string(), participants: z.array(z.string()).describe("Phone numbers or JIDs") },
        async ({ name, participants }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.createGroup(name, participants)) }] }; });
    s.tool("whatsapp_group_participants", "Add, remove, promote, or demote group members.",
        { group: z.string(), participants: z.array(z.string()), action: z.enum(["add", "remove", "promote", "demote"]) },
        async ({ group, participants, action }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.updateGroupParticipants(group, participants, action)) }] }; });
    s.tool("whatsapp_group_update_name", "Change a group's name.", { group: z.string(), name: z.string() },
        async ({ group, name }) => { const wa = await import("./integrations/whatsapp.js"); await wa.updateGroupSubject(group, name); return { content: [{ type: "text", text: "Group name updated." }] }; });
    s.tool("whatsapp_group_update_description", "Change a group's description.", { group: z.string(), description: z.string() },
        async ({ group, description }) => { const wa = await import("./integrations/whatsapp.js"); await wa.updateGroupDescription(group, description); return { content: [{ type: "text", text: "Group description updated." }] }; });
    s.tool("whatsapp_groups_list", "List all groups you're participating in.", {},
        async () => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getAllGroups()) }] }; });
    s.tool("whatsapp_group_invite", "Get the invite link for a group.", { group: z.string() },
        async ({ group }) => { const wa = await import("./integrations/whatsapp.js"); const code = await wa.getGroupInviteCode(group); return { content: [{ type: "text", text: `https://chat.whatsapp.com/${code}` }] }; });
    s.tool("whatsapp_group_leave", "Leave a WhatsApp group.", { group: z.string() },
        async ({ group }) => { const wa = await import("./integrations/whatsapp.js"); await wa.leaveGroup(group); return { content: [{ type: "text", text: "Left group." }] }; });
    s.tool("whatsapp_newsletter_create", "Create a new WhatsApp channel.", { name: z.string(), description: z.string().optional() },
        async ({ name, description }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.createNewsletter(name, description)) }] }; });
    s.tool("whatsapp_newsletter_follow", "Follow a WhatsApp channel.", { jid: z.string() },
        async ({ jid }) => { const wa = await import("./integrations/whatsapp.js"); await wa.followNewsletter(jid); return { content: [{ type: "text", text: "Followed." }] }; });
    s.tool("whatsapp_newsletter_unfollow", "Unfollow a WhatsApp channel.", { jid: z.string() },
        async ({ jid }) => { const wa = await import("./integrations/whatsapp.js"); await wa.unfollowNewsletter(jid); return { content: [{ type: "text", text: "Unfollowed." }] }; });
    s.tool("whatsapp_newsletter_messages", "Get messages from a WhatsApp channel.", { jid: z.string(), count: z.number().optional() },
        async ({ jid, count }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getNewsletterMessages(jid, count || 20)) }] }; });
    s.tool("whatsapp_newsletter_info", "Get info about a WhatsApp channel.", { jid: z.string() },
        async ({ jid }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getNewsletterMetadata(jid)) }] }; });
    s.tool("whatsapp_business_profile", "Get a business profile.", { chat: z.string() },
        async ({ chat }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getBusinessProfile(chat)) }] }; });
    s.tool("whatsapp_catalog", "Get a business's product catalog.", { chat: z.string(), limit: z.number().optional() },
        async ({ chat, limit }) => { const wa = await import("./integrations/whatsapp.js"); return { content: [{ type: "text", text: json(await wa.getCatalog(chat, limit || 50)) }] }; });
}

main().catch(console.error);

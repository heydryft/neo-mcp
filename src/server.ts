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
import * as db from "./db.js";
import { browserCommand, startBridge, isBridgeConnected } from "./bridge.js";

const NEO_INSTRUCTIONS = `Neo is a browser bridge that lets you operate the user's real accounts — LinkedIn, Twitter/X, WhatsApp, and ANY website they're logged into. No API keys needed.

## Built-in services
- LinkedIn: extract_auth("linkedin") once, then use linkedin_* tools
- Twitter/X: extract_auth("twitter") once, then use twitter_* tools
- WhatsApp: whatsapp_connect (QR code first time, auto-reconnects after)

## When a built-in tool doesn't exist for what the user wants
This is the critical workflow. Follow these steps EVERY TIME:

1. extract_auth("servicename") — grab auth tokens from the browser
2. network_capture(action: "start", navigate: "https://the-site.com/relevant-page") — start capturing network traffic and navigate to the page
3. network_requests() — list all API calls the page made (you'll see the internal API endpoints)
4. network_request_detail(id: "...") — pick the relevant request and inspect its FULL headers (you need these for CSRF tokens, auth headers, content-type, etc.)
5. authenticated_fetch(url, method, headers: {...}) — replay the request with the exact headers you found in step 4
6. create_tool(...) — once you have a working request, wrap it into a permanent tool so you never repeat this discovery

## IMPORTANT: authenticated_fetch vs fetch in create_tool
- authenticated_fetch goes through the browser extension — carries the page's cookies automatically but you CAN'T control CSRF headers (many sites will reject with 403)
- In create_tool code, use fetch() directly with helpers.credentials() to set cookies and CSRF headers explicitly. This is more reliable.

Example — the RIGHT way to call LinkedIn's API in a custom tool:
  const creds = helpers.credentials("linkedin");
  const res = await fetch(url, {
    headers: {
      "Cookie": "li_at=" + creds.li_at + "; JSESSIONID=\\"" + creds.jsessionid + "\\"",
      "csrf-token": creds.jsessionid,
      "x-restli-protocol-version": "2.0.0",
    }
  });

Use network_request_detail to discover what headers a site needs, then replicate them with fetch() + helpers.credentials() in create_tool.

## create_tool
Creates a REAL MCP tool available immediately (no restart needed). The AI writes JavaScript that runs with:
- params — tool input parameters
- helpers.credentials(service) — stored auth tokens (from extract_auth)
- helpers.browserFetch(url, opts) — request from browser context (auto cookies, no custom headers)
- helpers.store(service, key, val) — store a credential
- helpers.query(collection, opts) / helpers.insert(collection, data) — SQLite collections
- fetch — standard fetch (YOU control all headers, cookies, body — use this for API calls)

Always create_tool after you get a working pattern. This saves the user from waiting for rediscovery next time.`;

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
            if (key === "service" || key === "cookies" || !value || typeof value !== "string") continue;
            creds[key] = value as string;
            try { db.storeCredential(storageKey, key, value as string); } catch {}
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

// ── WhatsApp ─────────────────────────────────────────────────────────────────

server.tool(
    "whatsapp_connect",
    "Connect to WhatsApp. Returns a QR code to scan on first use. Auto-reconnects after that.",
    {},
    async () => {
        const wa = await import("./integrations/whatsapp.js");
        await wa.connect();
        return { content: [{ type: "text", text: "WhatsApp connected." }] };
    }
);

server.tool(
    "whatsapp_chats",
    "List WhatsApp chats with last message and unread count.",
    { limit: z.number().optional() },
    async ({ limit }) => {
        const wa = await import("./integrations/whatsapp.js");
        const chats = await wa.getChats(limit || 30);
        return { content: [{ type: "text", text: json(chats) }] };
    }
);

server.tool(
    "whatsapp_read",
    "Read messages from a WhatsApp chat. Pass chat ID, phone number, or contact name.",
    {
        chat: z.string().describe("Chat ID, phone number (e.g. +919876543210), or contact name"),
        limit: z.number().optional(),
    },
    async ({ chat, limit }) => {
        const wa = await import("./integrations/whatsapp.js");
        const messages = await wa.readMessages(chat, limit || 30);
        return { content: [{ type: "text", text: json(messages) }] };
    }
);

server.tool(
    "whatsapp_send",
    "Send a WhatsApp message.",
    {
        to: z.string().describe("Phone number, contact name, or chat ID"),
        text: z.string(),
    },
    async ({ to, text }) => {
        const wa = await import("./integrations/whatsapp.js");
        const result = await wa.sendMessage(to, text);
        return { content: [{ type: "text", text: json(result) }] };
    }
);

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
                if (key === "service" || key === "cookies" || !value || typeof value !== "string") continue;
                creds[key] = value as string;
                try { db.storeCredential(storageKey, key, value as string); } catch {}
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
    s.tool("linkedin_feed", "Get your LinkedIn feed.", { count: z.number().optional(), ...profileParam },
        async ({ count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.getFeed(getLinkedInAuth(profile), count || 20)) }] }));
    s.tool("linkedin_post", "Create a LinkedIn post.", { text: z.string(), ...profileParam },
        async ({ text, profile }) => ({ content: [{ type: "text", text: json(await linkedin.createPost(getLinkedInAuth(profile), text)) }] }));
    s.tool("linkedin_search", "Search for people on LinkedIn.", { query: z.string(), count: z.number().optional(), ...profileParam },
        async ({ query, count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.searchPeople(getLinkedInAuth(profile), query, count || 10)) }] }));
    s.tool("linkedin_connections", "List your LinkedIn connections.", { count: z.number().optional(), ...profileParam },
        async ({ count, profile }) => ({ content: [{ type: "text", text: json(await linkedin.getConnections(getLinkedInAuth(profile), count || 50)) }] }));

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
}

main().catch(console.error);

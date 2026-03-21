#!/usr/bin/env node
/**
 * Generate docs/*.md tool reference tables and README.md by spawning the
 * MCP server in stdio mode, sending tools/list, and rendering markdown.
 *
 * Usage: node scripts/generate-docs.js
 * Runs automatically as part of `npm run build`.
 */

import { spawn } from "child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DOCS = join(ROOT, "docs");
const TEMPLATE = join(DOCS, "README.template.md");
const README = join(ROOT, "README.md");

// ── Prefix → doc file mapping ──────────────────────────────────────────────
// To add a new service: just add its prefix here and the rest is automatic.

const SERVICE_MAP = {
    "linkedin.md": {
        title: "LinkedIn",
        prefixes: ["linkedin_"],
        prompt: '*"Extract my LinkedIn auth and get my recent posts with engagement metrics"*',
        notes: "",
    },
    "twitter.md": {
        title: "Twitter/X",
        prefixes: ["twitter_"],
        prompt: '*"Extract my Twitter auth and show me my recent tweets"*',
        notes: "Bearer tokens and GraphQL query IDs are extracted automatically from Twitter's JS bundle — they rotate on every deploy so they can't be hardcoded.",
    },
    "slack.md": {
        title: "Slack",
        prefixes: ["slack_"],
        prompt: '*"Extract my Slack auth and show me unread messages"*',
        notes: "",
    },
    "gmail.md": {
        title: "Gmail",
        prefixes: ["gmail_"],
        prompt: '*"Connect my Gmail"* → OAuth sign-in → connected',
        notes: "Gmail uses OAuth 2.0. Default credentials are included — just call `gmail_connect` and sign in. See [Gmail OAuth Setup](../README.md#gmail-oauth-setup) for custom credentials.",
    },
    "whatsapp.md": {
        title: "WhatsApp",
        prefixes: ["whatsapp_"],
        prompt: '*"Connect to WhatsApp"* → scan the QR code → connected forever',
        notes: "",
    },
    "google-calendar.md": {
        title: "Google Calendar",
        prefixes: ["gcal_"],
        prompt: '*"Connect my Google Calendar"*',
        notes: "",
    },
    "google-drive.md": {
        title: "Google Drive",
        prefixes: ["gdrive_", "google_drive_"],
        prompt: '*"Connect my Google Drive and list my files"*',
        notes: "",
    },
    "notion.md": {
        title: "Notion",
        prefixes: ["notion_"],
        prompt: '*"Extract my Notion auth and list my pages"*',
        notes: "",
    },
    "discord.md": {
        title: "Discord",
        prefixes: ["discord_"],
        prompt: '*"Extract my Discord auth"*',
        notes: "",
    },
    "github.md": {
        title: "GitHub",
        prefixes: ["github_"],
        prompt: '*"Extract my GitHub auth"*',
        notes: "",
    },
    "browser.md": {
        title: "Browser & API Discovery",
        prefixes: ["extract_auth", "authenticated_fetch", "network_capture", "network_requests", "network_request_detail", "bridge_status", "web_scrape", "diff_monitor"],
        prompt: "No pre-built integration needed — these work on any site you're logged into.",
        notes: "",
    },
    "custom-tools.md": {
        title: "Custom Tools",
        prefixes: ["create_tool", "update_tool", "list_custom_tools", "get_tool_code", "delete_tool"],
        prompt: '*"Build me a Notion integration"* — Claude will reverse-engineer the API and create tools.',
        notes: "",
    },
    "collections.md": {
        title: "Structured Data Storage",
        prefixes: ["collection_"],
        prompt: "Claude can create its own database tables to store anything it collects.",
        notes: "",
    },
    "analytics.md": {
        title: "Analytics",
        prefixes: ["content_monitor", "track_post", "analytics_report"],
        prompt: "Track and monitor engagement across LinkedIn and Twitter posts over time.",
        notes: "",
    },
    "credentials.md": {
        title: "Credential Management",
        prefixes: ["list_credentials", "store_credential", "list_profiles"],
        prompt: "Manage stored auth tokens and service profiles.",
        notes: "",
    },
    "workflows.md": {
        title: "Workflows",
        prefixes: ["smart_inbox", "meeting_prep", "contact_enrich", "repurpose_content", "content_calendar", "pr_digest", "discover_api"],
        prompt: "Pre-built multi-step workflows that combine tools.",
        notes: "",
    },
};

function getDocFile(toolName) {
    for (const [file, config] of Object.entries(SERVICE_MAP)) {
        for (const prefix of config.prefixes) {
            if (toolName === prefix || toolName.startsWith(prefix)) return file;
        }
    }
    return null;
}

function formatParams(schema) {
    if (!schema || !schema.properties) return "—";
    const parts = [];
    const required = new Set(schema.required || []);
    for (const [name, prop] of Object.entries(schema.properties)) {
        if (name === "profile") continue;
        const req = required.has(name) ? "" : "?";
        parts.push(`\`${name}${req}\``);
    }
    return parts.join(", ") || "—";
}

// ── MCP server interaction ──────────────────────────────────────────────────

async function getToolsList() {
    return new Promise((resolve, reject) => {
        const proc = spawn("node", [join(ROOT, "dist/server.js")], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, NEO_TRANSPORT: "stdio" },
            timeout: 15000,
        });

        let stdout = "";
        proc.stdout.on("data", (d) => { stdout += d.toString(); });

        let stderr = "";
        proc.stderr.on("data", (d) => { stderr += d.toString(); });

        const initMsg = JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "docs-generator", version: "1.0.0" },
            },
        });

        const toolsMsg = JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
        });

        proc.stdin.write(initMsg + "\n");
        setTimeout(() => proc.stdin.write(toolsMsg + "\n"), 2000);

        setTimeout(() => {
            proc.kill();
            for (const line of stdout.split("\n").filter(Boolean)) {
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === 2 && msg.result?.tools) { resolve(msg.result.tools); return; }
                } catch {}
            }
            reject(new Error(`Could not parse tools/list.\nstderr: ${stderr.slice(0, 500)}`));
        }, 8000);

        proc.on("error", reject);
    });
}

// ── Rendering ───────────────────────────────────────────────────────────────

function groupTools(tools) {
    const groups = {};
    const unmapped = [];
    for (const tool of tools) {
        const file = getDocFile(tool.name);
        if (file) {
            if (!groups[file]) groups[file] = [];
            groups[file].push(tool);
        } else {
            unmapped.push(tool.name);
        }
    }
    if (unmapped.length > 0) {
        console.log(`[generate-docs] Unmapped tools: ${unmapped.join(", ")}`);
    }
    return groups;
}

function renderToolTable(tools) {
    const lines = [
        "| Tool | Description | Parameters |",
        "|------|-------------|------------|",
    ];
    for (const t of tools) {
        const params = formatParams(t.inputSchema);
        const desc = (t.description || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
        lines.push(`| \`${t.name}\` | ${desc} | ${params} |`);
    }
    return lines.join("\n");
}

const START = "<!-- AUTO-GENERATED:START -->";
const END = "<!-- AUTO-GENERATED:END -->";

function updateDocFile(filePath, config, table) {
    if (!existsSync(filePath)) {
        const lines = [
            `# ${config.title}`,
            "",
            `> ${config.prompt}`,
            "",
        ];
        if (config.notes) lines.push(config.notes, "");
        lines.push("## Tools", "", START, table, END, "");
        writeFileSync(filePath, lines.join("\n"));
        console.log(`  Created ${filePath}`);
        return;
    }

    const content = readFileSync(filePath, "utf-8");
    const startIdx = content.indexOf(START);
    const endIdx = content.indexOf(END);

    if (startIdx === -1 || endIdx === -1) {
        const updated = content.trimEnd() + `\n\n## Tools\n\n${START}\n${table}\n${END}\n`;
        writeFileSync(filePath, updated);
        console.log(`  Appended tools to ${filePath}`);
        return;
    }

    const updated = content.slice(0, startIdx + START.length) + "\n" + table + "\n" + content.slice(endIdx);
    writeFileSync(filePath, updated);
    console.log(`  Updated ${filePath}`);
}

// ── README generation ───────────────────────────────────────────────────────

const INT_START = "<!-- INTEGRATIONS:START -->";
const INT_END = "<!-- INTEGRATIONS:END -->";

function renderIntegrationsSection(groups) {
    const sections = [];

    for (const [file, config] of Object.entries(SERVICE_MAP)) {
        const tools = groups[file];
        if (!tools || tools.length === 0) continue;

        const lines = [`### ${config.title}`, ""];
        lines.push(`> ${config.prompt}`, "");
        if (config.notes) lines.push(config.notes, "");

        // Compact tool table for README
        lines.push("| Tool | What it does |");
        lines.push("|------|---|");
        for (const t of tools) {
            const desc = (t.description || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
            lines.push(`| \`${t.name}\` | ${desc} |`);
        }
        lines.push("");
        lines.push(`[Full documentation with parameters →](docs/${file})`, "");

        sections.push(lines.join("\n"));
    }

    return sections.join("\n");
}

function renderToolStats(tools, groups) {
    const serviceCount = Object.values(groups).filter(g => g.length > 0).length;
    return `**${tools.length}+ tools** across **${serviceCount} integrations** — LinkedIn, Twitter/X, Slack, Gmail, WhatsApp, Google Calendar, Google Drive, Notion, Discord, GitHub, and more.`;
}

function updateReadme(tools, groups) {
    if (!existsSync(TEMPLATE)) {
        console.log("  No README template found, skipping README generation");
        return;
    }

    let readme = readFileSync(TEMPLATE, "utf-8");

    // Replace tool stats
    readme = readme.replace("<!-- TOOL_STATS -->", renderToolStats(tools, groups));

    // Replace integrations section
    const startIdx = readme.indexOf(INT_START);
    const endIdx = readme.indexOf(INT_END);

    if (startIdx === -1 || endIdx === -1) {
        console.log("  No INTEGRATIONS markers in template, skipping");
        return;
    }

    const integrations = renderIntegrationsSection(groups);
    readme = readme.slice(0, startIdx + INT_START.length) + "\n\n" + integrations + "\n" + readme.slice(endIdx);
    writeFileSync(README, readme);
    console.log(`  Generated README.md (${readme.split("\n").length} lines)`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log("[generate-docs] Fetching tools list from MCP server...");

    let tools;
    try {
        tools = await getToolsList();
    } catch (e) {
        console.error(`[generate-docs] Failed: ${e.message}`);
        console.error("[generate-docs] Skipping docs generation.");
        process.exit(0);
    }

    console.log(`[generate-docs] Found ${tools.length} tools\n`);

    mkdirSync(DOCS, { recursive: true });
    const groups = groupTools(tools);

    // Generate per-service docs
    for (const [file, config] of Object.entries(SERVICE_MAP)) {
        const fileTools = groups[file];
        if (!fileTools || fileTools.length === 0) continue;
        const table = renderToolTable(fileTools);
        updateDocFile(join(DOCS, file), config, table);
    }

    // Generate README.md from template
    console.log("");
    updateReadme(tools, groups);

    // Summary
    console.log("\n[generate-docs] Summary:");
    for (const [file, fileTools] of Object.entries(groups)) {
        const config = SERVICE_MAP[file];
        console.log(`  ${config?.title || file}: ${fileTools.length} tools`);
    }
    console.log("");
}

main().catch((e) => {
    console.error(e);
    process.exit(0);
});

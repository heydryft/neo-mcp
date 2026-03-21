/**
 * Discord integration for Neo MCP.
 *
 * Uses browser-extracted user token via Neo's credential system (extract_auth).
 * Communicates with Discord's REST API v10.
 */

const API = "https://discord.com/api/v10";

export interface DiscordAuth {
    token: string;
    _cookies?: string;
}

// Set by the MCP server at init
let _browserCommand: ((method: string, params: Record<string, any>) => Promise<any>) | null = null;

export function setBrowserCommand(fn: (method: string, params: Record<string, any>) => Promise<any>) {
    _browserCommand = fn;
}

// ── API Layer ────────────────────────────────────────────────────────────────

async function discordApi<T = any>(
    auth: DiscordAuth,
    path: string,
    options: { method?: string; body?: any; params?: Record<string, string> } = {}
): Promise<T> {
    const url = new URL(`${API}${path}`);
    if (options.params) {
        for (const [k, v] of Object.entries(options.params)) url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {
        Authorization: auth.token,
        "User-Agent": "DiscordBot (neo-mcp, 1.0)",
    };

    if (options.body) {
        headers["Content-Type"] = "application/json";
    }

    if (_browserCommand) {
        const result = await _browserCommand("browser_fetch", {
            url: url.toString(),
            method: options.method || "GET",
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
        });
        if (result.error) throw new Error(result.error);
        if (!result.ok) {
            const text = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
            throw new Error(`Discord API ${result.status}: ${text.slice(0, 300)}`);
        }
        return result.body as T;
    }

    // Fallback: direct fetch
    const response = await fetch(url.toString(), {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Discord API ${response.status}: ${text.slice(0, 300)}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : ({} as T);
}

// ── Users ────────────────────────────────────────────────────────────────────

export async function getMe(auth: DiscordAuth): Promise<{
    id: string; username: string; discriminator: string; globalName: string | null; avatar: string | null; email: string | null;
}> {
    const u = await discordApi<any>(auth, "/users/@me");
    return {
        id: u.id,
        username: u.username,
        discriminator: u.discriminator,
        globalName: u.global_name || null,
        avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
        email: u.email || null,
    };
}

export async function getUserProfile(auth: DiscordAuth, userId: string): Promise<{
    id: string; username: string; discriminator: string; globalName: string | null; avatar: string | null; banner: string | null; bot: boolean;
}> {
    const u = await discordApi<any>(auth, `/users/${userId}`);
    return {
        id: u.id,
        username: u.username,
        discriminator: u.discriminator,
        globalName: u.global_name || null,
        avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
        banner: u.banner ? `https://cdn.discordapp.com/banners/${u.id}/${u.banner}.png` : null,
        bot: !!u.bot,
    };
}

// ── Guilds (Servers) ─────────────────────────────────────────────────────────

export async function listGuilds(auth: DiscordAuth): Promise<Array<{
    id: string; name: string; icon: string | null; owner: boolean; permissions: string;
}>> {
    const guilds = await discordApi<any[]>(auth, "/users/@me/guilds");
    return guilds.map((g: any) => ({
        id: g.id,
        name: g.name,
        icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
        owner: !!g.owner,
        permissions: g.permissions,
    }));
}

export async function getGuild(auth: DiscordAuth, guildId: string): Promise<{
    id: string; name: string; icon: string | null; description: string | null; memberCount: number; ownerId: string;
}> {
    const g = await discordApi<any>(auth, `/guilds/${guildId}`, { params: { with_counts: "true" } });
    return {
        id: g.id,
        name: g.name,
        icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
        description: g.description || null,
        memberCount: g.approximate_member_count || 0,
        ownerId: g.owner_id,
    };
}

export async function getGuildMembers(auth: DiscordAuth, guildId: string, limit = 100): Promise<Array<{
    userId: string; username: string; globalName: string | null; nick: string | null; roles: string[]; joinedAt: string;
}>> {
    const members = await discordApi<any[]>(auth, `/guilds/${guildId}/members`, {
        params: { limit: String(Math.min(limit, 1000)) },
    });
    return members.map((m: any) => ({
        userId: m.user.id,
        username: m.user.username,
        globalName: m.user.global_name || null,
        nick: m.nick || null,
        roles: m.roles || [],
        joinedAt: m.joined_at,
    }));
}

// ── Channels ─────────────────────────────────────────────────────────────────

export async function listChannels(auth: DiscordAuth, guildId: string): Promise<Array<{
    id: string; name: string; type: string; topic: string | null; position: number; parentId: string | null;
}>> {
    const CHANNEL_TYPES: Record<number, string> = {
        0: "text", 2: "voice", 4: "category", 5: "announcement", 10: "announcement_thread",
        11: "public_thread", 12: "private_thread", 13: "stage", 15: "forum", 16: "media",
    };
    const channels = await discordApi<any[]>(auth, `/guilds/${guildId}/channels`);
    return channels.map((c: any) => ({
        id: c.id,
        name: c.name,
        type: CHANNEL_TYPES[c.type] || `unknown(${c.type})`,
        topic: c.topic || null,
        position: c.position,
        parentId: c.parent_id || null,
    }));
}

export async function getChannel(auth: DiscordAuth, channelId: string): Promise<{
    id: string; name: string; type: string; topic: string | null; guildId: string | null;
}> {
    const CHANNEL_TYPES: Record<number, string> = {
        0: "text", 1: "dm", 2: "voice", 3: "group_dm", 4: "category", 5: "announcement",
        10: "announcement_thread", 11: "public_thread", 12: "private_thread", 13: "stage", 15: "forum", 16: "media",
    };
    const c = await discordApi<any>(auth, `/channels/${channelId}`);
    return {
        id: c.id,
        name: c.name || "",
        type: CHANNEL_TYPES[c.type] || `unknown(${c.type})`,
        topic: c.topic || null,
        guildId: c.guild_id || null,
    };
}

// ── Messages ─────────────────────────────────────────────────────────────────

interface DiscordMessage {
    id: string;
    channelId: string;
    author: string;
    authorId: string;
    content: string;
    timestamp: string;
    attachments: Array<{ filename: string; url: string }>;
    embeds: number;
    reactions: Array<{ emoji: string; count: number }>;
}

function mapMessage(m: any): DiscordMessage {
    return {
        id: m.id,
        channelId: m.channel_id,
        author: m.author?.global_name || m.author?.username || "unknown",
        authorId: m.author?.id || "",
        content: m.content || "",
        timestamp: m.timestamp,
        attachments: (m.attachments || []).map((a: any) => ({ filename: a.filename, url: a.url })),
        embeds: (m.embeds || []).length,
        reactions: (m.reactions || []).map((r: any) => ({
            emoji: r.emoji.name || r.emoji.id || "?",
            count: r.count,
        })),
    };
}

export async function readMessages(auth: DiscordAuth, channelId: string, limit = 50): Promise<DiscordMessage[]> {
    const messages = await discordApi<any[]>(auth, `/channels/${channelId}/messages`, {
        params: { limit: String(Math.min(limit, 100)) },
    });
    return messages.map(mapMessage);
}

export async function sendMessage(auth: DiscordAuth, channelId: string, content: string): Promise<DiscordMessage> {
    const m = await discordApi<any>(auth, `/channels/${channelId}/messages`, {
        method: "POST",
        body: { content },
    });
    return mapMessage(m);
}

export async function searchMessages(auth: DiscordAuth, guildId: string, query: string, limit = 25): Promise<DiscordMessage[]> {
    const data = await discordApi<any>(auth, `/guilds/${guildId}/messages/search`, {
        params: { content: query, limit: String(Math.min(limit, 25)) },
    });
    // Search returns messages grouped in arrays
    return (data.messages || []).flat().map(mapMessage);
}

// ── DMs ──────────────────────────────────────────────────────────────────────

export async function listDMs(auth: DiscordAuth): Promise<Array<{
    id: string; type: string; recipients: Array<{ id: string; username: string; globalName: string | null }>; lastMessageId: string | null;
}>> {
    const channels = await discordApi<any[]>(auth, "/users/@me/channels");
    return channels.map((c: any) => ({
        id: c.id,
        type: c.type === 1 ? "dm" : "group_dm",
        recipients: (c.recipients || []).map((r: any) => ({
            id: r.id,
            username: r.username,
            globalName: r.global_name || null,
        })),
        lastMessageId: c.last_message_id || null,
    }));
}

export async function readDMs(auth: DiscordAuth, channelId: string, limit = 50): Promise<DiscordMessage[]> {
    return readMessages(auth, channelId, limit);
}

export async function sendDM(auth: DiscordAuth, userId: string, content: string): Promise<DiscordMessage> {
    // Create or get existing DM channel
    const channel = await discordApi<any>(auth, "/users/@me/channels", {
        method: "POST",
        body: { recipient_id: userId },
    });
    return sendMessage(auth, channel.id, content);
}

// ── Reactions ────────────────────────────────────────────────────────────────

export async function addReaction(auth: DiscordAuth, channelId: string, messageId: string, emoji: string): Promise<void> {
    const encoded = encodeURIComponent(emoji);
    await discordApi(auth, `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, {
        method: "PUT",
    });
}

export async function removeReaction(auth: DiscordAuth, channelId: string, messageId: string, emoji: string): Promise<void> {
    const encoded = encodeURIComponent(emoji);
    await discordApi(auth, `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, {
        method: "DELETE",
    });
}

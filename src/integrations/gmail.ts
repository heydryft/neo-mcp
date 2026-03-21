/**
 * Gmail integration for Neo MCP via OAuth 2.0.
 *
 * Supports multiple accounts via the profile system.
 * Default OAuth credentials are shipped; users can override with env vars.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

// Default OAuth credentials — users can override via env vars.
// These are safe to ship: OAuth client secrets for installed/web apps
// are not truly secret (Google's docs confirm this).
const DEFAULT_CLIENT_ID = "124854636684-gvnkpjojb79nsq25047e2lv1utajm78u.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET = "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";

export function getClientId(): string {
    return process.env.GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID;
}

export function getClientSecret(): string {
    return process.env.GOOGLE_CLIENT_SECRET || DEFAULT_CLIENT_SECRET;
}

export interface GmailAuth {
    access_token: string;
}

// ── Token Management ─────────────────────────────────────────────────────────

// In-memory access token cache: profile → { token, expiresAt }
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function getOAuthUrl(redirectUri: string, profile?: string): string {
    const params = new URLSearchParams({
        client_id: getClientId(),
        redirect_uri: redirectUri,
        response_type: "code",
        scope: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/gmail.labels",
        ].join(" "),
        access_type: "offline",
        prompt: "consent",
        // Pass profile through state so callback knows which profile to store under
        state: profile || "default",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
}> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: getClientId(),
            client_secret: getClientSecret(),
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
        }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`OAuth token exchange failed: ${JSON.stringify(data)}`);
    return data as any;
}

export async function refreshAccessToken(refreshToken: string, profile = "default"): Promise<string> {
    // Check cache
    const cached = tokenCache.get(profile);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            refresh_token: refreshToken,
            client_id: getClientId(),
            client_secret: getClientSecret(),
            grant_type: "refresh_token",
        }),
    });
    const data: any = await res.json();
    if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);

    tokenCache.set(profile, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
    return data.access_token;
}

// ── API Layer ────────────────────────────────────────────────────────────────

async function gmailApi<T = any>(auth: GmailAuth, endpoint: string, opts: {
    method?: string;
    params?: Record<string, string>;
    body?: any;
} = {}): Promise<T> {
    const url = new URL(`${GMAIL_API}${endpoint}`);
    if (opts.params) for (const [k, v] of Object.entries(opts.params)) url.searchParams.set(k, v);

    const fetchOpts: RequestInit = {
        method: opts.method || "GET",
        headers: { Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" },
    };
    if (opts.body) fetchOpts.body = JSON.stringify(opts.body);

    const res = await fetch(url.toString(), fetchOpts);
    const data = await res.json();
    if (!res.ok) throw new Error(`Gmail API ${endpoint}: ${JSON.stringify(data.error || data)}`);
    return data as T;
}

// ── Profile ──────────────────────────────────────────────────────────────────

export async function getProfile(auth: GmailAuth): Promise<{ email: string; messagesTotal: number; threadsTotal: number; historyId: string }> {
    const data = await gmailApi<any>(auth, "/users/me/profile");
    return { email: data.emailAddress, messagesTotal: data.messagesTotal, threadsTotal: data.threadsTotal, historyId: data.historyId };
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface GmailMessage {
    id: string;
    threadId: string;
    from: string;
    to: string;
    subject: string;
    snippet: string;
    body: string;
    date: string;
    labels: string[];
    isUnread: boolean;
}

function parseHeaders(headers: any[]): Record<string, string> {
    const h: Record<string, string> = {};
    for (const { name, value } of headers || []) h[name.toLowerCase()] = value;
    return h;
}

function decodeBody(payload: any): string {
    // Try plain text first, then html
    if (payload.body?.data) {
        return Buffer.from(payload.body.data, "base64url").toString("utf-8");
    }
    if (payload.parts) {
        // Prefer text/plain
        const plain = payload.parts.find((p: any) => p.mimeType === "text/plain");
        if (plain?.body?.data) return Buffer.from(plain.body.data, "base64url").toString("utf-8");
        const html = payload.parts.find((p: any) => p.mimeType === "text/html");
        if (html?.body?.data) {
            const raw = Buffer.from(html.body.data, "base64url").toString("utf-8");
            return raw.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
        }
        // Nested multipart
        for (const part of payload.parts) {
            if (part.parts) {
                const nested = decodeBody(part);
                if (nested) return nested;
            }
        }
    }
    return "";
}

function parseMessage(msg: any): GmailMessage {
    const headers = parseHeaders(msg.payload?.headers);
    return {
        id: msg.id,
        threadId: msg.threadId,
        from: headers.from || "",
        to: headers.to || "",
        subject: headers.subject || "",
        snippet: msg.snippet || "",
        body: decodeBody(msg.payload),
        date: headers.date || "",
        labels: msg.labelIds || [],
        isUnread: (msg.labelIds || []).includes("UNREAD"),
    };
}

export async function listMessages(auth: GmailAuth, opts: {
    query?: string;
    label?: string;
    maxResults?: number;
    pageToken?: string;
} = {}): Promise<{ messages: Array<{ id: string; threadId: string }>; nextPageToken?: string }> {
    const params: Record<string, string> = { maxResults: String(opts.maxResults || 20) };
    if (opts.query) params.q = opts.query;
    if (opts.label) params.labelIds = opts.label;
    if (opts.pageToken) params.pageToken = opts.pageToken;
    return await gmailApi(auth, "/users/me/messages", { params });
}

export async function getMessage(auth: GmailAuth, messageId: string, format: "full" | "metadata" | "minimal" = "full"): Promise<GmailMessage> {
    const msg = await gmailApi<any>(auth, `/users/me/messages/${messageId}`, { params: { format } });
    return parseMessage(msg);
}

export async function getInbox(auth: GmailAuth, opts: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
} = {}): Promise<{ messages: GmailMessage[]; nextPageToken?: string }> {
    const q = opts.query ? `in:inbox ${opts.query}` : "in:inbox";
    const list = await listMessages(auth, { query: q, maxResults: opts.maxResults || 20, pageToken: opts.pageToken });
    if (!list.messages?.length) return { messages: [], nextPageToken: list.nextPageToken };

    const messages = await Promise.all(
        list.messages.map((m) => getMessage(auth, m.id))
    );
    return { messages, nextPageToken: list.nextPageToken };
}

export async function searchMail(auth: GmailAuth, query: string, maxResults = 20, pageToken?: string): Promise<{ messages: GmailMessage[]; nextPageToken?: string }> {
    const list = await listMessages(auth, { query, maxResults, pageToken });
    if (!list.messages?.length) return { messages: [], nextPageToken: list.nextPageToken };

    const messages = await Promise.all(
        list.messages.map((m) => getMessage(auth, m.id))
    );
    return { messages, nextPageToken: list.nextPageToken };
}

// ── Threads ──────────────────────────────────────────────────────────────────

export async function getThread(auth: GmailAuth, threadId: string): Promise<{ id: string; messages: GmailMessage[] }> {
    const data = await gmailApi<any>(auth, `/users/me/threads/${threadId}`, { params: { format: "full" } });
    return { id: data.id, messages: (data.messages || []).map(parseMessage) };
}

// ── Send ─────────────────────────────────────────────────────────────────────

function buildRawEmail(to: string, subject: string, body: string, opts?: {
    cc?: string; bcc?: string; replyTo?: string; inReplyTo?: string; references?: string; threadId?: string;
}): string {
    const lines: string[] = [
        `To: ${to}`,
        `Subject: ${subject}`,
        `Content-Type: text/plain; charset=utf-8`,
    ];
    if (opts?.cc) lines.push(`Cc: ${opts.cc}`);
    if (opts?.bcc) lines.push(`Bcc: ${opts.bcc}`);
    if (opts?.replyTo) lines.push(`Reply-To: ${opts.replyTo}`);
    if (opts?.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
    if (opts?.references) lines.push(`References: ${opts.references}`);
    lines.push("", body);
    return Buffer.from(lines.join("\r\n")).toString("base64url");
}

export async function sendEmail(auth: GmailAuth, to: string, subject: string, body: string, opts?: {
    cc?: string; bcc?: string; replyTo?: string; threadId?: string;
}): Promise<{ id: string; threadId: string }> {
    const raw = buildRawEmail(to, subject, body, opts);
    const payload: any = { raw };
    if (opts?.threadId) payload.threadId = opts.threadId;
    return await gmailApi(auth, "/users/me/messages/send", { method: "POST", body: payload });
}

export async function replyToThread(auth: GmailAuth, threadId: string, body: string): Promise<{ id: string; threadId: string }> {
    // Get the last message in the thread to build reply headers
    const thread = await getThread(auth, threadId);
    const lastMsg = thread.messages[thread.messages.length - 1];
    const headers = {
        inReplyTo: lastMsg.id,
        references: lastMsg.id,
        threadId,
    };
    return await sendEmail(auth, lastMsg.from, `Re: ${lastMsg.subject}`, body, headers);
}

export async function createDraft(auth: GmailAuth, to: string, subject: string, body: string, opts?: {
    cc?: string; bcc?: string; threadId?: string;
}): Promise<{ id: string; messageId: string }> {
    const raw = buildRawEmail(to, subject, body, opts);
    const payload: any = { message: { raw } };
    if (opts?.threadId) payload.message.threadId = opts.threadId;
    const data = await gmailApi<any>(auth, "/users/me/drafts", { method: "POST", body: payload });
    return { id: data.id, messageId: data.message?.id };
}

// ── Modify ───────────────────────────────────────────────────────────────────

export async function modifyMessage(auth: GmailAuth, messageId: string, addLabels: string[] = [], removeLabels: string[] = []): Promise<void> {
    await gmailApi(auth, `/users/me/messages/${messageId}/modify`, {
        method: "POST",
        body: { addLabelIds: addLabels, removeLabelIds: removeLabels },
    });
}

export async function markAsRead(auth: GmailAuth, messageId: string): Promise<void> {
    await modifyMessage(auth, messageId, [], ["UNREAD"]);
}

export async function markAsUnread(auth: GmailAuth, messageId: string): Promise<void> {
    await modifyMessage(auth, messageId, ["UNREAD"], []);
}

export async function archiveMessage(auth: GmailAuth, messageId: string): Promise<void> {
    await modifyMessage(auth, messageId, [], ["INBOX"]);
}

export async function trashMessage(auth: GmailAuth, messageId: string): Promise<void> {
    await gmailApi(auth, `/users/me/messages/${messageId}/trash`, { method: "POST" });
}

export async function starMessage(auth: GmailAuth, messageId: string): Promise<void> {
    await modifyMessage(auth, messageId, ["STARRED"], []);
}

export async function unstarMessage(auth: GmailAuth, messageId: string): Promise<void> {
    await modifyMessage(auth, messageId, [], ["STARRED"]);
}

// ── Labels ───────────────────────────────────────────────────────────────────

export async function listLabels(auth: GmailAuth): Promise<Array<{ id: string; name: string; type: string; messagesTotal?: number; messagesUnread?: number }>> {
    const data = await gmailApi<any>(auth, "/users/me/labels");
    return (data.labels || []).map((l: any) => ({
        id: l.id, name: l.name, type: l.type,
        messagesTotal: l.messagesTotal, messagesUnread: l.messagesUnread,
    }));
}

export async function createLabel(auth: GmailAuth, name: string): Promise<{ id: string; name: string }> {
    return await gmailApi(auth, "/users/me/labels", {
        method: "POST",
        body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
}

export async function deleteLabel(auth: GmailAuth, labelId: string): Promise<void> {
    await gmailApi(auth, `/users/me/labels/${labelId}`, { method: "DELETE" });
}

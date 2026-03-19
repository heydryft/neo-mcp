const log = (...args) => console.error("[whatsapp]", ...args);
const err = (...args) => console.error("[whatsapp:error]", ...args);
/**
 * WhatsApp integration via Baileys v7.
 *
 * v7 removed makeInMemoryStore. We collect chats/contacts/messages
 * directly from socket events.
 */
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, } from "@whiskeysockets/baileys";
import pino from "pino";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
// Standalone config — no dependency on Neo's config system
const getConfig = () => ({ dataDir: join(homedir(), ".neo-mcp") });
// ── State ────────────────────────────────────────────────────────────────────
let sock = null;
let connectionState = "disconnected";
let currentQR = null;
let onQRCallback = null;
// In-memory store (populated from events, persisted to disk)
const chats = new Map();
const contacts = new Map();
const messageStore = new Map();
// JID/LID → display name, built from pushNames in messages + contacts
const nameCache = new Map();
// Phone JID ↔ LID mapping (WhatsApp multi-device uses both)
const jidToLid = new Map();
const lidToJid = new Map();
function getStorePath() {
    return join(getConfig().dataDir, "whatsapp-store.json");
}
function loadStore() {
    try {
        const path = getStorePath();
        if (!existsSync(path))
            return;
        const data = JSON.parse(readFileSync(path, "utf-8"));
        for (const [id, chat] of Object.entries(data.chats || {})) {
            chats.set(id, chat);
            if (chat.name)
                nameCache.set(id, chat.name);
            // Build LID mapping from chat metadata
            if (chat.lid) {
                jidToLid.set(id, chat.lid);
                lidToJid.set(chat.lid, id);
            }
        }
        for (const [id, contact] of Object.entries(data.contacts || {})) {
            contacts.set(id, contact);
            const name = contact.name || contact.notify;
            if (name)
                nameCache.set(id, name);
            // Build LID mapping from contact metadata
            if (contact.lid) {
                jidToLid.set(id, contact.lid);
                lidToJid.set(contact.lid, id);
            }
        }
        for (const [jid, msgs] of Object.entries(data.messages || {})) {
            messageStore.set(jid, msgs);
            // Extract pushNames from stored messages (WhatsApp display names)
            for (const m of msgs) {
                if (m.pushName) {
                    const sender = m.key?.participant || m.key?.remoteJid;
                    if (sender)
                        nameCache.set(sender, m.pushName);
                }
            }
        }
        for (const [id, name] of Object.entries(data.names || {}))
            nameCache.set(id, name);
        for (const [jid, lid] of Object.entries(data.jidToLid || {})) {
            jidToLid.set(jid, lid);
            lidToJid.set(lid, jid);
        }
        // Cross-reference: if a contact has a phone JID and a LID chat exists,
        // try to match them by name
        buildLidMappingFromNames();
        log(`[whatsapp] Loaded: ${chats.size} chats, ${contacts.size} contacts, ${nameCache.size} names, ${jidToLid.size} JID↔LID mappings`);
    }
    catch { }
}
/**
 * Try to match phone JID contacts with LID chats by name.
 * WhatsApp uses LIDs internally but contacts have phone JIDs.
 */
function buildLidMappingFromNames() {
    // For each phone contact with a name, see if there's a LID contact/chat with the same name
    const phoneContacts = new Map(); // name → phone JID
    for (const [id, contact] of contacts) {
        if (id.endsWith("@s.whatsapp.net")) {
            const name = contact.name || contact.notify;
            if (name)
                phoneContacts.set(name.toLowerCase(), id);
        }
    }
    for (const [id, contact] of contacts) {
        if (id.endsWith("@lid")) {
            const name = contact.name || contact.notify;
            if (name && phoneContacts.has(name.toLowerCase())) {
                const phoneJid = phoneContacts.get(name.toLowerCase());
                if (!jidToLid.has(phoneJid)) {
                    jidToLid.set(phoneJid, id);
                    lidToJid.set(id, phoneJid);
                }
            }
        }
    }
}
function saveStore() {
    try {
        // Persist messages too (last 50 per chat to keep file size reasonable)
        const msgs = {};
        for (const [jid, store] of messageStore) {
            msgs[jid] = store.slice(-50);
        }
        const data = {
            chats: Object.fromEntries(chats),
            contacts: Object.fromEntries(contacts),
            names: Object.fromEntries(nameCache),
            jidToLid: Object.fromEntries(jidToLid),
            messages: msgs,
        };
        writeFileSync(getStorePath(), JSON.stringify(data), "utf-8");
    }
    catch { }
}
// Save to disk periodically
let saveTimer = null;
export function getConnectionState() {
    return { state: connectionState, qr: currentQR };
}
export function onQR(callback) {
    onQRCallback = callback;
}
export async function connect() {
    if (sock && connectionState === "connected")
        return sock;
    const config = getConfig();
    const authDir = join(config.dataDir, "whatsapp-auth");
    if (!existsSync(authDir))
        mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: "silent" });
    connectionState = "connecting";
    // Load persisted store from disk (survives restarts)
    loadStore();
    // Save store every 30 seconds
    if (saveTimer)
        clearInterval(saveTimer);
    saveTimer = setInterval(saveStore, 30000);
    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        generateHighQualityLinkPreview: false,
        syncFullHistory: true,
    });
    sock.ev.on("creds.update", saveCreds);
    // ── Connection events ────────────────────────────────────────────
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQR = qr;
            connectionState = "qr";
            if (onQRCallback)
                onQRCallback(qr);
        }
        if (connection === "close") {
            connectionState = "disconnected";
            currentQR = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => connect(), 3000);
            }
        }
        if (connection === "open") {
            connectionState = "connected";
            currentQR = null;
            // Wait for history sync before declaring ready
            log("[whatsapp] Connected, waiting for sync...");
        }
    });
    // ── Data events ────────────────────────────────────────────────────
    sock.ev.on("messaging-history.set", (data) => {
        for (const chat of data.chats) {
            if (!chat.id)
                continue;
            chats.set(chat.id, chat);
            if (chat.name)
                nameCache.set(chat.id, chat.name);
            if (chat.lid) {
                jidToLid.set(chat.id, chat.lid);
                lidToJid.set(chat.lid, chat.id);
            }
        }
        for (const contact of data.contacts) {
            if (!contact.id)
                continue;
            contacts.set(contact.id, contact);
            const name = contact.name || contact.notify;
            if (name)
                nameCache.set(contact.id, name);
            if (contact.lid) {
                jidToLid.set(contact.id, contact.lid);
                lidToJid.set(contact.lid, contact.id);
            }
        }
        for (const msg of data.messages) {
            const jid = msg.key.remoteJid;
            if (!jid)
                continue;
            if (!messageStore.has(jid))
                messageStore.set(jid, []);
            messageStore.get(jid).push(msg);
            // Cache pushName
            if (msg.pushName) {
                const sender = msg.key.participant || msg.key.remoteJid;
                if (sender)
                    nameCache.set(sender, msg.pushName);
            }
        }
        buildLidMappingFromNames();
        saveStore();
        log(`[whatsapp] Synced: ${data.chats?.length || 0} chats, ${data.contacts?.length || 0} contacts, ${data.messages?.length || 0} messages, ${jidToLid.size} JID↔LID mappings`);
    });
    sock.ev.on("chats.upsert", (newChats) => {
        for (const chat of newChats) {
            if (chat.id)
                chats.set(chat.id, { ...chats.get(chat.id), ...chat });
        }
        saveStore();
    });
    sock.ev.on("chats.update", (updates) => {
        for (const update of updates) {
            if (!update.id)
                continue;
            const existing = chats.get(update.id);
            if (existing)
                chats.set(update.id, { ...existing, ...update });
        }
    });
    sock.ev.on("contacts.upsert", (newContacts) => {
        for (const contact of newContacts) {
            if (!contact.id)
                continue;
            contacts.set(contact.id, contact);
            const name = contact.name || contact.notify;
            if (name)
                nameCache.set(contact.id, name);
            if (contact.lid) {
                jidToLid.set(contact.id, contact.lid);
                lidToJid.set(contact.lid, contact.id);
            }
        }
        saveStore();
    });
    sock.ev.on("contacts.update", (updates) => {
        for (const update of updates) {
            if (!update.id)
                continue;
            const existing = contacts.get(update.id);
            if (existing)
                contacts.set(update.id, { ...existing, ...update });
        }
    });
    sock.ev.on("messages.upsert", (data) => {
        for (const msg of data.messages) {
            const jid = msg.key.remoteJid;
            if (!jid)
                continue;
            if (!messageStore.has(jid))
                messageStore.set(jid, []);
            const store = messageStore.get(jid);
            if (!store.some((m) => m.key.id === msg.key.id)) {
                store.push(msg);
                if (store.length > 200)
                    store.splice(0, store.length - 200);
            }
            // Cache pushName from every message
            if (msg.pushName) {
                const sender = msg.key.participant || msg.key.remoteJid;
                if (sender)
                    nameCache.set(sender, msg.pushName);
            }
        }
    });
    return sock;
}
export function disconnect() {
    saveStore();
    if (saveTimer) {
        clearInterval(saveTimer);
        saveTimer = null;
    }
    if (sock) {
        sock.end(undefined);
        sock = null;
        connectionState = "disconnected";
    }
}
function ensureConnected() {
    if (!sock || connectionState !== "connected") {
        throw new Error("WhatsApp not connected. Call whatsapp_connect first.");
    }
    return sock;
}
/**
 * Auto-connect if saved credentials exist. Call on startup.
 */
export async function autoConnect() {
    const config = getConfig();
    const authDir = join(config.dataDir, "whatsapp-auth");
    const credsFile = join(authDir, "creds.json");
    if (existsSync(credsFile)) {
        try {
            await connect();
        }
        catch { }
    }
}
// ── Read ─────────────────────────────────────────────────────────────────────
/**
 * Wait until we have at least some chat data from the sync.
 * Baileys connects first, then syncs history async.
 */
async function waitForSync(timeoutMs = 10000) {
    // If store was loaded from disk, we already have data
    if (chats.size > 0)
        return;
    // Otherwise wait for events
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && chats.size === 0) {
        await new Promise((r) => setTimeout(r, 500));
    }
}
export async function getChats(limit = 20) {
    ensureConnected();
    await waitForSync();
    const chatList = Array.from(chats.values())
        .filter((c) => !!c.id)
        .sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0))
        .slice(0, limit);
    return chatList.map((chat) => {
        const id = chat.id;
        const name = chat?.name || resolveName(id);
        const msgs = messageStore.get(id);
        const lastMsg = msgs?.[msgs.length - 1];
        const lastText = lastMsg?.message?.conversation ||
            lastMsg?.message?.extendedTextMessage?.text ||
            "";
        return {
            id,
            name,
            lastMessage: lastText.slice(0, 100),
            lastTimestamp: chat.conversationTimestamp || 0,
            unreadCount: chat.unreadCount || 0,
            isGroup: id.endsWith("@g.us"),
        };
    });
}
export async function readMessages(chatId, limit = 50) {
    const s = ensureConnected();
    await waitForSync();
    const jid = normalizeJid(chatId);
    // Check both phone JID and LID for messages
    let msgs = messageStore.get(jid) || [];
    if (msgs.length === 0) {
        // Try the alternate ID (phone↔LID)
        const altJid = jidToLid.get(jid) || lidToJid.get(jid);
        if (altJid)
            msgs = messageStore.get(altJid) || [];
    }
    return msgs
        .slice(-limit)
        .filter((m) => m.message)
        .map((m) => {
        const body = m.message?.conversation ||
            m.message?.extendedTextMessage?.text ||
            m.message?.imageMessage?.caption ||
            m.message?.videoMessage?.caption ||
            m.message?.documentMessage?.fileName ||
            "[media]";
        return {
            id: m.key.id || "",
            source: "whatsapp",
            channel: jid,
            channelName: chatId,
            from: m.key.fromMe ? "me" : (m.pushName || resolveName(m.key.participant || jid)),
            body,
            timestamp: new Date(m.messageTimestamp * 1000),
        };
    });
}
// ── Write ────────────────────────────────────────────────────────────────────
export async function sendMessage(chatId, text) {
    const s = ensureConnected();
    let jid = normalizeJid(chatId);
    // Prefer LID for sending if available (WhatsApp multi-device)
    const lid = jidToLid.get(jid);
    if (lid)
        jid = lid;
    const result = await s.sendMessage(jid, { text });
    return { id: result?.key?.id || "" };
}
export async function replyToMessage(chatId, text, quotedMessageId) {
    const s = ensureConnected();
    const jid = normalizeJid(chatId);
    const result = await s.sendMessage(jid, { text }, {
        quoted: { key: { remoteJid: jid, id: quotedMessageId } },
    });
    return { id: result?.key?.id || "" };
}
export async function markRead(chatId) {
    const s = ensureConnected();
    const jid = normalizeJid(chatId);
    await s.readMessages([{ remoteJid: jid, id: undefined }]);
}
// ── Contacts ─────────────────────────────────────────────────────────────────
export async function findContact(query) {
    const s = ensureConnected();
    await waitForSync();
    const queryLower = query.toLowerCase();
    // Search by phone number
    if (/^\+?\d+$/.test(query.replace(/[\s-]/g, ""))) {
        const phone = query.replace(/[\s\-+]/g, "");
        const jid = `${phone}@s.whatsapp.net`;
        const results = await s.onWhatsApp(jid);
        const result = results?.[0];
        if (result?.exists) {
            return [{ id: jid, name: resolveName(jid), phone }];
        }
        return [];
    }
    // Search by name in contacts
    const found = [];
    // Search contacts AND nameCache
    const searched = new Set();
    for (const [jid, contact] of contacts) {
        const name = contact?.name || contact?.notify || resolveName(jid);
        if (name.toLowerCase().includes(queryLower)) {
            found.push({ id: jid, name, phone: jid.split("@")[0] });
            searched.add(jid);
        }
    }
    // Also search name cache (catches pushNames from group messages)
    for (const [jid, name] of nameCache) {
        if (searched.has(jid))
            continue;
        if (name.toLowerCase().includes(queryLower)) {
            found.push({ id: jid, name, phone: jid.split("@")[0] });
        }
    }
    return found;
}
// ── Helpers ──────────────────────────────────────────────────────────────────
/** Debug: dump raw store state */
export function debugStore() {
    const messageCounts = {};
    for (const [jid, msgs] of messageStore) {
        messageCounts[resolveName(jid) + " (" + jid + ")"] = msgs.length;
    }
    return {
        chatCount: chats.size,
        contactCount: contacts.size,
        messageChats: Array.from(messageStore.keys()),
        messageCounts,
        nameCount: nameCache.size,
        sampleNames: Array.from(nameCache.entries()).slice(0, 20),
    };
}
/** Resolve a JID/LID to a human-readable name */
function resolveName(jid) {
    // 1. Check our name cache (built from pushNames + contacts)
    const cached = nameCache.get(jid);
    if (cached)
        return cached;
    // 2. Check contacts
    const contact = contacts.get(jid);
    if (contact) {
        const name = contact.name || contact.notify;
        if (name)
            return name;
    }
    // 3. Strip the @suffix for phone numbers
    const bare = jid.split("@")[0];
    // If it's a phone number, format it
    if (/^\d+$/.test(bare) && bare.length >= 10) {
        return "+" + bare;
    }
    return bare;
}
function normalizeJid(input) {
    if (input.includes("@"))
        return input;
    const cleaned = input.replace(/[\s\-+]/g, "");
    if (/^\d+$/.test(cleaned))
        return `${cleaned}@s.whatsapp.net`;
    return input;
}
//# sourceMappingURL=whatsapp.js.map
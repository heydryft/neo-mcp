/**
 * WhatsApp integration via Baileys v7.
 *
 * v7 removed makeInMemoryStore. We collect chats/contacts/messages
 * directly from socket events.
 */
import { type WASocket } from "@whiskeysockets/baileys";
interface Message {
    source: string;
    channel: string;
    channelName?: string;
    from: string;
    body: string;
    timestamp: Date;
    subject?: string;
}
export interface SlackAuth {
    token: string;
    cookie?: string;
}
export declare function getConnectionState(): {
    state: "disconnected" | "connecting" | "qr" | "connected";
    qr: string | null;
};
export declare function onQR(callback: (qr: string) => void): void;
export declare function connect(): Promise<WASocket>;
export declare function disconnect(): void;
/**
 * Auto-connect if saved credentials exist. Call on startup.
 */
export declare function autoConnect(): Promise<void>;
export declare function getChats(limit?: number): Promise<Array<{
    id: string;
    name: string;
    lastMessage: string;
    lastTimestamp: number;
    unreadCount: number;
    isGroup: boolean;
}>>;
export declare function readMessages(chatId: string, limit?: number): Promise<Message[]>;
export declare function sendMessage(chatId: string, text: string): Promise<{
    id: string;
}>;
export declare function replyToMessage(chatId: string, text: string, quotedMessageId: string): Promise<{
    id: string;
}>;
export declare function markRead(chatId: string): Promise<void>;
export declare function findContact(query: string): Promise<Array<{
    id: string;
    name: string;
    phone: string;
}>>;
/** Debug: dump raw store state */
export declare function debugStore(): {
    chatCount: number;
    contactCount: number;
    messageChats: string[];
    messageCounts: Record<string, number>;
    nameCount: number;
    sampleNames: Array<[string, string]>;
};
export {};

/**
 * Google Calendar integration for Neo MCP via OAuth 2.0.
 *
 * Reuses the same Google OAuth client credentials as Gmail.
 * Supports multiple accounts via the profile system.
 */

import { getClientId, getClientSecret } from "./gmail.js";

const GCAL_API = "https://www.googleapis.com/calendar/v3";

export interface GCalAuth {
    access_token: string;
}

// ── Token Management ─────────────────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function getOAuthUrl(redirectUri: string, profile?: string): string {
    const params = new URLSearchParams({
        client_id: getClientId(),
        redirect_uri: redirectUri,
        response_type: "code",
        scope: [
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/calendar.events",
        ].join(" "),
        access_type: "offline",
        prompt: "consent",
        state: profile || "default",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
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

    tokenCache.set(profile, {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    });
    return data.access_token;
}

// ── API wrapper ──────────────────────────────────────────────────────────────

async function calApi<T = any>(
    auth: GCalAuth,
    path: string,
    options: { method?: string; body?: any; params?: Record<string, string> } = {}
): Promise<T> {
    const url = new URL(`${GCAL_API}${path}`);
    if (options.params) {
        for (const [k, v] of Object.entries(options.params)) url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {
        "Authorization": `Bearer ${auth.access_token}`,
        "Accept": "application/json",
    };
    if (options.body) headers["Content-Type"] = "application/json";

    const res = await fetch(url.toString(), {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Google Calendar API ${res.status}: ${text.slice(0, 500)}`);
    }

    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) return res.json() as Promise<T>;
    return (await res.text()) as unknown as T;
}

// ── Calendars ────────────────────────────────────────────────────────────────

export async function listCalendars(auth: GCalAuth): Promise<any[]> {
    const data = await calApi<any>(auth, "/users/me/calendarList");
    return (data.items || []).map((c: any) => ({
        id: c.id,
        summary: c.summary,
        description: c.description,
        primary: c.primary || false,
        timeZone: c.timeZone,
        backgroundColor: c.backgroundColor,
        accessRole: c.accessRole,
    }));
}

// ── Events ───────────────────────────────────────────────────────────────────

function formatEvent(e: any): any {
    return {
        id: e.id,
        summary: e.summary,
        description: e.description,
        location: e.location,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        status: e.status,
        organizer: e.organizer?.email,
        creator: e.creator?.email,
        attendees: e.attendees?.map((a: any) => ({
            email: a.email,
            displayName: a.displayName,
            responseStatus: a.responseStatus,
            self: a.self || false,
        })),
        recurrence: e.recurrence,
        hangoutLink: e.hangoutLink,
        conferenceData: e.conferenceData ? {
            type: e.conferenceData.conferenceSolution?.name,
            uri: e.conferenceData.entryPoints?.find((ep: any) => ep.entryPointType === "video")?.uri,
        } : undefined,
        htmlLink: e.htmlLink,
        created: e.created,
        updated: e.updated,
    };
}

export async function listEvents(
    auth: GCalAuth,
    calendarId = "primary",
    options: { timeMin?: string; timeMax?: string; maxResults?: number; query?: string; singleEvents?: boolean; orderBy?: string } = {}
): Promise<any[]> {
    const params: Record<string, string> = {
        maxResults: String(options.maxResults || 25),
        singleEvents: String(options.singleEvents !== false),
        orderBy: options.orderBy || "startTime",
    };
    if (options.timeMin) params.timeMin = options.timeMin;
    if (options.timeMax) params.timeMax = options.timeMax;
    if (options.query) params.q = options.query;

    // Default: upcoming events from now
    if (!options.timeMin && !options.timeMax) {
        params.timeMin = new Date().toISOString();
    }

    const data = await calApi<any>(auth, `/calendars/${encodeURIComponent(calendarId)}/events`, { params });
    return (data.items || []).map(formatEvent);
}

export async function getEvent(auth: GCalAuth, calendarId: string, eventId: string): Promise<any> {
    const e = await calApi(auth, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    return formatEvent(e);
}

export async function createEvent(
    auth: GCalAuth,
    calendarId = "primary",
    event: {
        summary: string;
        description?: string;
        location?: string;
        start: string;
        end: string;
        attendees?: string[];
        timeZone?: string;
        recurrence?: string[];
        conferenceData?: boolean;
    }
): Promise<any> {
    const isAllDay = !event.start.includes("T");
    const body: any = {
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: isAllDay ? { date: event.start } : { dateTime: event.start, timeZone: event.timeZone },
        end: isAllDay ? { date: event.end } : { dateTime: event.end, timeZone: event.timeZone },
    };
    if (event.attendees) {
        body.attendees = event.attendees.map(email => ({ email }));
    }
    if (event.recurrence) {
        body.recurrence = event.recurrence;
    }

    const params: Record<string, string> = {};
    if (event.conferenceData) {
        body.conferenceData = {
            createRequest: {
                requestId: `neo-${Date.now()}`,
                conferenceSolutionKey: { type: "hangoutsMeet" },
            },
        };
        params.conferenceDataVersion = "1";
    }

    const e = await calApi(auth, `/calendars/${encodeURIComponent(calendarId)}/events`, {
        method: "POST",
        body,
        params,
    });
    return formatEvent(e);
}

export async function updateEvent(
    auth: GCalAuth,
    calendarId: string,
    eventId: string,
    updates: {
        summary?: string;
        description?: string;
        location?: string;
        start?: string;
        end?: string;
        timeZone?: string;
    }
): Promise<any> {
    const body: any = {};
    if (updates.summary !== undefined) body.summary = updates.summary;
    if (updates.description !== undefined) body.description = updates.description;
    if (updates.location !== undefined) body.location = updates.location;
    if (updates.start) {
        const isAllDay = !updates.start.includes("T");
        body.start = isAllDay ? { date: updates.start } : { dateTime: updates.start, timeZone: updates.timeZone };
    }
    if (updates.end) {
        const isAllDay = !updates.end.includes("T");
        body.end = isAllDay ? { date: updates.end } : { dateTime: updates.end, timeZone: updates.timeZone };
    }

    const e = await calApi(auth, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        body,
    });
    return formatEvent(e);
}

export async function deleteEvent(auth: GCalAuth, calendarId: string, eventId: string): Promise<void> {
    await calApi(auth, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
        method: "DELETE",
    });
}

export async function respondToEvent(
    auth: GCalAuth,
    calendarId: string,
    eventId: string,
    response: "accepted" | "declined" | "tentative"
): Promise<any> {
    // Get current event, update self's attendee status
    const event = await calApi(auth, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    const attendees = (event.attendees || []).map((a: any) => {
        if (a.self) return { ...a, responseStatus: response };
        return a;
    });

    const e = await calApi(auth, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        body: { attendees },
    });
    return formatEvent(e);
}

export async function quickAddEvent(auth: GCalAuth, calendarId: string, text: string): Promise<any> {
    const e = await calApi(auth, `/calendars/${encodeURIComponent(calendarId)}/events/quickAdd`, {
        method: "POST",
        params: { text },
    });
    return formatEvent(e);
}

// ── Free/Busy ────────────────────────────────────────────────────────────────

export async function freeBusy(
    auth: GCalAuth,
    calendarIds: string[],
    timeMin: string,
    timeMax: string
): Promise<any> {
    const data = await calApi(auth, "/freeBusy", {
        method: "POST",
        body: {
            timeMin,
            timeMax,
            items: calendarIds.map(id => ({ id })),
        },
    });

    const result: Record<string, any[]> = {};
    for (const [calId, info] of Object.entries(data.calendars || {})) {
        result[calId] = (info as any).busy || [];
    }
    return result;
}

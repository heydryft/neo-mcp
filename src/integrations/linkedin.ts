/**
 * LinkedIn integration via Voyager API.
 * Uses li_at cookie + JSESSIONID (csrf) extracted from browser.
 *
 * All requests go through the browser extension (browserFetch) because
 * LinkedIn blocks direct Node.js fetch via TLS fingerprinting / Cloudflare.
 */

const VOYAGER = "https://www.linkedin.com/voyager/api";

export interface LinkedInAuth {
    li_at: string;
    jsessionid: string;
}

// Set by the MCP server at init
let _browserCommand: ((method: string, params: Record<string, any>) => Promise<any>) | null = null;

export function setBrowserCommand(fn: (method: string, params: Record<string, any>) => Promise<any>) {
    _browserCommand = fn;
}

async function linkedinApi<T = any>(
    auth: LinkedInAuth,
    path: string,
    options: { method?: string; body?: any; params?: Record<string, string>; headers?: Record<string, string> } = {}
): Promise<T> {
    // Build query string without URL.searchParams — LinkedIn's GraphQL API requires
    // specific encoding: parentheses/colons/commas unencoded in variables syntax,
    // but URN colons encoded. Since all params are code-generated (not user input),
    // we pass them raw and let callers pre-encode URN values where needed.
    let urlStr = `${VOYAGER}${path}`;
    if (options.params) {
        const qs = Object.entries(options.params)
            .map(([k, v]) => `${k}=${v}`)
            .join("&");
        urlStr += `?${qs}`;
    }

    // csrf-token must be "ajax:{JSESSIONID}" — normalize if needed
    const csrfToken = auth.jsessionid.startsWith("ajax:")
        ? auth.jsessionid
        : `ajax:${auth.jsessionid}`;

    const headers: Record<string, string> = {
        "csrf-token": csrfToken,
        "x-restli-protocol-version": "2.0.0",
        "x-li-lang": "en_US",
        "Accept": "application/vnd.linkedin.normalized+json+2.1",
        ...(options.headers || {}),
    };

    if (options.body) {
        headers["Content-Type"] = "application/json";
    }

    // Route through browser extension — carries real browser TLS fingerprint
    if (_browserCommand) {
        const result = await _browserCommand("browser_fetch", {
            url: urlStr,
            method: options.method || "GET",
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
            credentials: "include",
        });

        if (result.error) throw new Error(result.error);
        if (!result.ok) {
            const text = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
            throw new Error(`LinkedIn API ${result.status}: ${text.slice(0, 200)}`);
        }

        return result.body as T;
    }

    // Fallback: direct fetch (may fail due to TLS fingerprinting)
    headers["Cookie"] = `li_at=${auth.li_at}; JSESSIONID="${auth.jsessionid}"`;
    headers["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    const response = await fetch(urlStr, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`LinkedIn API ${response.status}: ${text.slice(0, 200)}`);
    }

    return response.json() as Promise<T>;
}

/** Get the authenticated user's identity (URNs + miniProfile ID) */
async function getMe(auth: LinkedInAuth): Promise<{ objectUrn: string; entityUrn: string; miniProfileId: string }> {
    const data = await linkedinApi(auth, `/me`);
    const profile = data.miniProfile || data;

    // Extract fs_miniProfile ID from included entities (needed for newer GraphQL APIs)
    let miniProfileId = "";
    if (data.included) {
        for (const item of data.included) {
            if (item.entityUrn?.includes("fs_miniProfile")) {
                miniProfileId = item.entityUrn.replace("urn:li:fs_miniProfile:", "");
                break;
            }
        }
    }
    // Fallback: plainId field (some response formats provide this directly)
    if (!miniProfileId) miniProfileId = data.plainId || profile.plainId || "";

    return {
        objectUrn: profile.objectUrn || "",
        entityUrn: profile.entityUrn || profile.objectUrn || "",
        miniProfileId,
    };
}

/** Get a user's profile by vanity name (the URL slug) */
export async function getProfile(auth: LinkedInAuth, vanityName: string): Promise<any> {
    // The old /identity/profiles/{name}/profileView returns 410 (Gone).
    // Use the dash endpoint with memberIdentity query.
    const data = await linkedinApi(auth, `/identity/dash/profiles`, {
        params: {
            q: "memberIdentity",
            memberIdentity: vanityName,
            decorationId: "com.linkedin.voyager.dash.deco.identity.profile.FullProfile-91",
        },
    });

    // Normalized response: find the Profile entity in the included array
    const included: any[] = data.included || [];
    const profile = included.find((e: any) =>
        e.$type?.includes("Profile") && (e.firstName || e.publicIdentifier)
    ) || {};

    return {
        firstName: profile.firstName,
        lastName: profile.lastName,
        headline: profile.headline?.text || profile.headline,
        summary: profile.summary?.text || profile.summary,
        location: profile.geoLocation?.geo?.defaultLocalizedName
            || profile.geoLocationName
            || profile.locationName,
        industry: profile.industry?.name || profile.industryName,
        publicId: profile.publicIdentifier || vanityName,
        connections: profile.connectionsCount || profile.connectionCount,
        followers: profile.followersCount || profile.followerCount,
    };
}

/** Get the authenticated user's own posts with engagement metrics */
export async function getMyPosts(auth: LinkedInAuth, count = 20): Promise<any[]> {
    let memberUrn = "";
    try {
        const me = await getMe(auth);
        memberUrn = me.objectUrn || me.entityUrn || "";
    } catch {}

    // GraphQL feed with RECENCY sort to surface own posts first; fetch extra to allow filtering
    const data = await linkedinApi(auth, `/graphql`, {
        params: {
            queryId: "voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475",
            variables: `(start:0,count:${count * 3},sortOrder:RECENCY)`,
        },
    });

    const posts = extractGraphQLFeedPosts(data, count * 3);
    if (memberUrn) {
        const mine = posts.filter(p => p.authorUrn && p.authorUrn.includes(memberUrn));
        if (mine.length > 0) return mine.slice(0, count);
    }
    return posts.slice(0, count);
}

/** Get the user's feed */
export async function getFeed(auth: LinkedInAuth, count = 20): Promise<any[]> {
    const data = await linkedinApi(auth, `/graphql`, {
        params: {
            queryId: "voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475",
            variables: `(start:0,count:${count},sortOrder:RELEVANCE)`,
        },
    });

    return extractGraphQLFeedPosts(data, count);
}

function extractPosts(data: any, max: number): any[] {
    // LinkedIn's normalized response:
    //   - `elements` = ordered list of feed items (may contain update URN references)
    //   - `included` = all referenced entities (profiles, social details, post bodies)
    // We need to check BOTH: iterate elements first (correct order), fall back to included.
    const included: any[] = data.included || [];
    const elements: any[] = data.elements || [];

    // Build a URN → entity map for cross-referencing
    const byUrn = new Map<string, any>();
    for (const item of included) {
        const urn = item.entityUrn || item.urn || item.updateUrn;
        if (urn) byUrn.set(urn, item);
    }

    // Collect candidate update items in feed order.
    // `elements` may be the updates themselves OR references that need resolving.
    const candidates: any[] = [];
    for (const el of elements) {
        // Direct update entity
        if (el.commentary || el.updateUrn || el["$type"]?.includes("Update")) {
            candidates.push(el);
            continue;
        }
        // URN reference — resolve from included
        const ref = el["*updateV2Urn"] || el["*update"] || el.entityUrn;
        if (ref && byUrn.has(ref)) {
            candidates.push(byUrn.get(ref));
            continue;
        }
        // Wrapped value
        const inner = el.value?.["com.linkedin.voyager.feed.render.UpdateV2"];
        if (inner) {
            candidates.push(inner);
        }
    }

    // If elements didn't yield updates (some endpoints put everything in included)
    if (candidates.length === 0) {
        for (const item of included) {
            const isUpdate = item["$type"]?.includes("UpdateV2")
                || item["$type"]?.includes("update.Update")
                || !!item.updateUrn;
            if (isUpdate) candidates.push(item);
        }
    }

    const posts: any[] = [];

    for (const item of candidates) {
        if (posts.length >= max) break;

        // Extract post text from commentary (several nesting shapes exist)
        const commentary = item.commentary?.text?.text
            || item.commentary?.text
            || "";

        if (!commentary) continue;

        // Look up the socialDetail entity by URN reference.
        const socialDetailUrn = item["*socialDetail"];
        const socialDetail = socialDetailUrn
            ? byUrn.get(socialDetailUrn)
            : item.socialDetail;

        const socialCounts = socialDetail?.totalSocialActivityCounts || {};

        // Resolve author from the actor reference
        const actorUrn = item["*actor"] || item.actor;
        const actor = actorUrn ? byUrn.get(actorUrn) : null;
        const authorName = actor
            ? `${actor.firstName || ""} ${actor.lastName || ""}`.trim()
                || actor.title?.text
                || ""
            : "";

        posts.push({
            text: commentary.slice(0, 1000),
            author: authorName || undefined,
            created: item.createdAt ? new Date(item.createdAt).toISOString() : null,
            likes: socialCounts.numLikes || 0,
            comments: socialCounts.numComments || 0,
            reposts: socialCounts.numShares || 0,
            impressions: socialCounts.numImpressions || null,
            urn: item.updateUrn || item.urn || item.entityUrn,
        });
    }

    return posts;
}

/** Parse the GraphQL feed response (voyagerFeedDashMainFeed GraphQL API) */
function extractGraphQLFeedPosts(data: any, max: number): any[] {
    // LinkedIn GraphQL normalized format:
    //   data.data.feedDashMainFeedByMainFeed.*elements = array of URN strings
    //   data.data[urn] = the actual FeedComponent entity
    //   included = referenced profiles, companies, etc.
    const graphData: Record<string, any> = data?.data?.data || data?.data || {};
    const included: any[] = data?.included || [];

    // Build URN → entity lookup from URN-keyed top-level keys in graphData
    const byUrn = new Map<string, any>();
    for (const [key, value] of Object.entries(graphData)) {
        if (key.startsWith("urn:")) byUrn.set(key, value);
    }
    for (const item of included) {
        const urn = item.entityUrn || item.urn;
        if (urn) byUrn.set(urn, item);
    }

    // Get the ordered list of feed component URNs (or direct element objects)
    const feedObj: any = graphData["feedDashMainFeedByMainFeed"] || {};
    const rawElements: any[] = feedObj["*elements"] || feedObj.elements || [];

    const posts: any[] = [];

    for (const raw of rawElements) {
        if (posts.length >= max) break;

        // Resolve: may be a URN string or an inline object
        const component: any = typeof raw === "string" ? (byUrn.get(raw) || {}) : raw;
        if (!component || Object.keys(component).length === 0) continue;

        // Extract text content
        const commentary =
            component.commentary?.text?.text ||
            component.commentary?.text ||
            component.content?.article?.description?.text ||
            "";
        if (!commentary) continue;

        // Extract actor / author
        const actor: any = component.actor || {};
        const authorName =
            actor.name?.text ||
            actor.title?.text ||
            `${actor.firstName?.text || ""} ${actor.lastName?.text || ""}`.trim() ||
            "";
        const authorUrn = actor.urn || actor["*actor"] || "";

        // Social counts — may be embedded or referenced in included entities
        const socialDetail: any = component.socialDetail || component.threadSocialDetail || {};
        let socialCounts: any = socialDetail.totalSocialActivityCounts || {};

        // If counts are zero, look up from included fsd_socialActivityCounts entities
        if (!socialCounts.numLikes && !socialCounts.numComments) {
            const activityUrn = component.updateMetadata?.backendUrn || "";
            if (activityUrn) {
                const countsUrn = `urn:li:fsd_socialActivityCounts:${activityUrn}`;
                const countsEntity = byUrn.get(countsUrn);
                if (countsEntity) socialCounts = countsEntity;
            }
        }

        // Post URN — prefer the activity URN embedded in the feed component
        const postUrn =
            component.updateMetadata?.urn ||
            component.entityUrn ||
            (typeof raw === "string" ? raw : "");

        posts.push({
            text: commentary.slice(0, 1000),
            author: authorName || undefined,
            authorUrn: authorUrn || undefined,
            created: component.createdAt ? new Date(component.createdAt).toISOString() : null,
            likes: socialCounts.numLikes || 0,
            comments: socialCounts.numComments || 0,
            reposts: socialCounts.numShares || 0,
            impressions: socialCounts.numImpressions || null,
            urn: postUrn,
        });
    }

    return posts;
}

/** Create a text post */
export async function createPost(auth: LinkedInAuth, text: string): Promise<any> {
    // Get author URN (needed for UGC post format)
    let authorUrn = "";
    try {
        const me = await getMe(auth);
        // LinkedIn returns different URN formats depending on context:
        //   urn:li:member:12345 → need urn:li:person:12345
        //   urn:li:fsd_profile:ACoAAA... → need urn:li:person:ACoAAA... (extract the ID)
        const urn = me.objectUrn || me.entityUrn || "";
        if (urn.includes("urn:li:member:")) {
            authorUrn = urn.replace("urn:li:member:", "urn:li:person:");
        } else if (urn.includes("urn:li:fsd_profile:")) {
            authorUrn = urn.replace("urn:li:fsd_profile:", "urn:li:person:");
        } else if (urn.includes("urn:li:person:")) {
            authorUrn = urn;
        } else if (urn) {
            // Unknown format — try extracting the ID and using person URN
            const id = urn.split(":").pop() || "";
            authorUrn = `urn:li:person:${id}`;
        }
    } catch {}

    // Use normShares — the replacement for the deprecated /contentcreation/shares endpoint
    const body: any = {
        visibleToGuest: true,
        commentary: {
            text,
            attributes: [],
        },
        distribution: {
            feedDistribution: "MAIN_FEED",
            thirdPartyDistributionChannels: [],
        },
    };
    if (authorUrn) body.author = authorUrn;

    const data = await linkedinApi(auth, `/contentcreation/normShares`, {
        method: "POST",
        body,
    });

    return { posted: true, urn: data.urn || data.value?.urn };
}

/** Search for people via GraphQL search endpoint */
export async function searchPeople(auth: LinkedInAuth, query: string, count = 10): Promise<any[]> {
    // Encode the query for use in URL (spaces → %20, etc.) but keep GraphQL syntax raw
    const encodedQuery = encodeURIComponent(query);
    const data = await linkedinApi(auth, `/graphql`, {
        params: {
            variables: `(start:0,origin:GLOBAL_SEARCH_HEADER,query:(keywords:${encodedQuery},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))`,
            queryId: "voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0",
        },
    });

    const included: any[] = data?.included || [];
    const results: any[] = [];

    for (const item of included) {
        if (results.length >= count) break;
        // EntityResultViewModel contains search result data (name, headline, location)
        const isResult = item.$type?.includes("EntityResultViewModel") || item.title?.text;
        if (!isResult || !item.title?.text) continue;

        // Extract vanity name from navigationUrl
        let publicId = "";
        const navUrl = item.navigationUrl || item.navigationContext?.url || "";
        const match = navUrl.match(/\/in\/([^?/]+)/);
        if (match) publicId = match[1];

        results.push({
            name: item.title?.text || "",
            headline: item.primarySubtitle?.text || "",
            publicId,
            location: item.secondarySubtitle?.text || "",
        });
    }

    return results;
}

/** Get connections — returns connected member URNs with timestamps.
 *  Profile details (name, headline) require the GraphQL search endpoint. */
export async function getConnections(auth: LinkedInAuth, count = 50): Promise<any[]> {
    // Use GraphQL search to find connections (network filter: F = first-degree)
    const data = await linkedinApi(auth, `/graphql`, {
        params: {
            variables: `(start:0,origin:MEMBER_PROFILE_CANNED_SEARCH,query:(flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:network,value:List(F)),(key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))`,
            queryId: "voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0",
        },
    });

    const included: any[] = data?.included || [];
    const results: any[] = [];

    for (const item of included) {
        if (results.length >= count) break;
        const isResult = item.$type?.includes("EntityResultViewModel") || (item.title?.text && item.primarySubtitle?.text);
        if (!isResult || !item.title?.text) continue;

        let publicId = "";
        const navUrl = item.navigationUrl || item.navigationContext?.url || "";
        const match = navUrl.match(/\/in\/([^?/]+)/);
        if (match) publicId = match[1];

        results.push({
            name: item.title?.text || "",
            headline: item.primarySubtitle?.text || "",
            publicId,
            location: item.secondarySubtitle?.text || "",
        });
    }

    return results;
}

// ── Messaging ────────────────────────────────────────────────────────────────

/** List recent message conversations via LinkedIn's GraphQL messaging API */
export async function getConversations(auth: LinkedInAuth, count = 20): Promise<any> {
    // Get miniProfile ID needed for mailbox URN
    const me = await getMe(auth);
    const profileId = me.miniProfileId || me.entityUrn?.replace(/.*:/, "") || "";
    if (!profileId) throw new Error("Could not determine profile ID for messaging");

    // URN colons must be percent-encoded in messaging GraphQL variables
    const mailboxUrn = `urn%3Ali%3Afsd_profile%3A${profileId}`;

    // Use LinkedIn's GraphQL messaging endpoint (same as web UI)
    const data = await linkedinApi(auth, `/voyagerMessagingGraphQL/graphql`, {
        params: {
            queryId: "messengerConversations.0d5e6781bbee71c3e51c8843c6519f48",
            variables: `(mailboxUrn:${mailboxUrn})`,
        },
        headers: { "Accept": "application/json" },
    });

    // Response may be a JSON string (application/graphql content type) — parse if needed.
    // Sanitize control characters that can appear in LinkedIn message bodies.
    let parsed = data;
    if (typeof data === "string") {
        // Replace unescaped control characters (except already-escaped sequences)
        // with their Unicode escape form for safe JSON parsing
        const sanitized = data.replace(/[\x00-\x1f\x7f]/g, (ch: string) => {
            if (ch === "\n" || ch === "\r" || ch === "\t") return ch;
            return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
        });
        parsed = JSON.parse(sanitized);
    }

    // GraphQL response has deeply nested conversation objects — walk the tree to find them
    const conversations: any[] = [];
    function findConversations(obj: any, depth: number) {
        if (!obj || typeof obj !== "object" || depth > 8) return;
        if (Array.isArray(obj)) { obj.forEach((i: any) => findConversations(i, depth + 1)); return; }
        // Direct match: object is a conversation
        if (obj._type === "com.linkedin.messenger.Conversation" && obj.conversationParticipants) {
            conversations.push(obj);
            return;
        }
        if (obj.elements && Array.isArray(obj.elements)) {
            for (const el of obj.elements) {
                if (el._type === "com.linkedin.messenger.Conversation" || el.conversationParticipants || el.lastActivityAt) {
                    conversations.push(el);
                }
            }
        }
        for (const k of Object.keys(obj)) {
            if (typeof obj[k] === "object" && obj[k] !== null) findConversations(obj[k], depth + 1);
        }
    }
    findConversations(parsed, 0);

    // Decode the mailbox URN for self-filtering (was percent-encoded for the API call)
    const myUrn = `urn:li:fsd_profile:${profileId}`;
    const results = conversations.slice(0, count).map((conv: any) => {
        // Extract participants (excluding self)
        const participants: any[] = [];
        for (const p of (conv.conversationParticipants || [])) {
            if (p.hostIdentityUrn === myUrn) continue;
            const member = p.participantType?.member;
            const org = p.participantType?.organization;
            if (member) {
                const name = [member.firstName?.text || "", member.lastName?.text || ""].filter(Boolean).join(" ");
                participants.push({
                    name,
                    headline: member.headline?.text || "",
                    profileUrl: member.profileUrl || "",
                });
            } else if (org) {
                participants.push({
                    name: org.name?.text || "Organization",
                    headline: org.tagline || "",
                    profileUrl: org.pageUrl || "",
                });
            }
        }

        // Extract last message — may be in conv.messages.elements or contentMetadata.messages.elements
        const msgs = conv.messages?.elements || conv.contentMetadata?.messages?.elements || [];
        const lastMsg = msgs[0] || {};
        const msgText = lastMsg.body?.text || "";
        const senderMember = lastMsg.actor?.participantType?.member;
        const senderOrg = lastMsg.actor?.participantType?.organization;
        const senderName = senderMember
            ? [senderMember.firstName?.text || "", senderMember.lastName?.text || ""].filter(Boolean).join(" ")
            : senderOrg?.name?.text || "";

        // Extract a usable conversation ID for getConversationMessages
        const convUrl = conv.conversationUrl || conv.contentMetadata?.conversationUrl || "";
        let conversationId = conv.entityUrn || conv.backendConversationUrn || "";
        if (!conversationId && convUrl) {
            const threadMatch = convUrl.match(/\/thread\/([^/?]+)/);
            if (threadMatch) conversationId = threadMatch[1];
        }

        return {
            conversationId,
            conversationUrl: convUrl,
            participants: participants.length > 0 ? participants : [{ name: "Unknown" }],
            lastMessage: msgText.slice(0, 500),
            lastMessageFrom: senderName,
            lastActivityAt: conv.lastActivityAt ? new Date(conv.lastActivityAt).toISOString() : null,
            unreadCount: conv.unreadCount || 0,
            read: conv.read || false,
            categories: conv.categories || [],
            subject: lastMsg.subject || null,
        };
    });

    if (results.length === 0) {
        return { note: "No conversations found", raw: JSON.stringify(parsed).slice(0, 2000) };
    }

    return { totalCount: results.length, conversations: results };
}

/** Get messages in a specific conversation */
export async function getConversationMessages(auth: LinkedInAuth, conversationId: string, count = 20): Promise<any[]> {
    // conversationId can be:
    //   - Full URL: "https://www.linkedin.com/messaging/thread/2-YWJj..."
    //   - Full URN: "urn:li:msg_conversation:2-YWJj..." or "urn:li:fs_conversation:..."
    //   - Thread ID: "2-YWJj..." (bare ID)
    let convUrn = conversationId;

    // Extract from URL
    if (convUrn.includes("/messaging/thread/")) {
        const match = convUrn.match(/\/thread\/([^/?]+)/);
        if (match) convUrn = match[1];
    }

    // Normalize to a full URN for the GraphQL variables string
    if (!convUrn.startsWith("urn:li:")) {
        convUrn = `urn:li:msg_conversation:(${convUrn})`;
    } else if (convUrn.startsWith("urn:li:fs_conversation:")) {
        const id = convUrn.replace("urn:li:fs_conversation:", "");
        convUrn = `urn:li:msg_conversation:(${id})`;
    } else if (convUrn.startsWith("urn:li:messagingThread:")) {
        const id = convUrn.replace("urn:li:messagingThread:", "");
        convUrn = `urn:li:msg_conversation:(${id})`;
    }

    // Full encode on the URN — LinkedIn requires encoded colons, parentheses, commas,
    // and equals signs within URN values. encodeURIComponent skips parens so we add those.
    const encodedConvUrn = encodeURIComponent(convUrn)
        .replace(/\(/g, "%28").replace(/\)/g, "%29");

    const data = await linkedinApi(auth, `/voyagerMessagingGraphQL/graphql`, {
        params: {
            queryId: "messengerMessages.5846eeb71c981f11e0134cb6626cc314",
            variables: `(conversationUrn:${encodedConvUrn})`,
        },
        headers: { "Accept": "application/json" },
    });

    // Response may be a JSON string (application/graphql content type) — parse if needed.
    // Sanitize control characters that can appear in message bodies.
    let parsed = data;
    if (typeof data === "string") {
        // Replace unescaped control characters (except already-escaped sequences)
        // with their Unicode escape form for safe JSON parsing
        const sanitized = data.replace(/[\x00-\x1f\x7f]/g, (ch: string) => {
            if (ch === "\n" || ch === "\r" || ch === "\t") return ch;
            return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
        });
        parsed = JSON.parse(sanitized);
    }

    // Walk the GraphQL response tree to find message objects
    const messages: any[] = [];
    function findMessages(obj: any, depth: number) {
        if (!obj || typeof obj !== "object" || depth > 7) return;
        if (Array.isArray(obj)) { obj.forEach(i => findMessages(i, depth + 1)); return; }
        // Message objects have body.text and deliveredAt
        if ((obj.body?.text !== undefined || obj.subject) && obj.deliveredAt !== undefined) {
            messages.push(obj);
            return;
        }
        if (obj.elements && Array.isArray(obj.elements)) {
            for (const el of obj.elements) findMessages(el, depth + 1);
        }
        for (const k of Object.keys(obj)) {
            if (typeof obj[k] === "object" && obj[k] !== null) findMessages(obj[k], depth + 1);
        }
    }
    findMessages(parsed, 0);

    return messages.slice(0, count).map((msg: any) => {
        const senderMember =
            msg.sender?.participantType?.member ||
            msg.actor?.participantType?.member;
        const senderName = senderMember
            ? [senderMember.firstName?.text || "", senderMember.lastName?.text || ""].filter(Boolean).join(" ")
            : "";

        return {
            messageId: msg.entityUrn || msg.backendMessageId || "",
            sender: senderName,
            body: (msg.body?.text || msg.subject || "").slice(0, 2000),
            sentAt: msg.deliveredAt ? new Date(msg.deliveredAt).toISOString() : null,
        };
    });
}

/** Send a message to a LinkedIn member */
export async function sendMessage(auth: LinkedInAuth, recipientUrn: string, body: string): Promise<any> {
    // recipientUrn should be like "urn:li:fsd_profile:ACoAAA..." or "urn:li:member:12345"
    // If a vanity name is passed, resolve it to a profile URN
    let targetUrn = recipientUrn;
    if (!targetUrn.startsWith("urn:")) {
        const data = await linkedinApi(auth, `/identity/dash/profiles`, {
            params: { q: "memberIdentity", memberIdentity: targetUrn },
        });
        const included: any[] = data.included || [];
        const profileEntity = included.find((e: any) => e.$type?.includes("Profile") && e.entityUrn);
        if (profileEntity?.entityUrn) {
            targetUrn = profileEntity.entityUrn;
        } else {
            throw new Error(`Could not resolve member URN for "${recipientUrn}"`);
        }
    }

    const msgBody = {
        keyVersion: "LEGACY_INBOX",
        conversationCreate: {
            recipients: [targetUrn],
            subtype: "MEMBER_TO_MEMBER",
            eventCreate: {
                value: {
                    "com.linkedin.voyager.messaging.create.MessageCreate": {
                        attributedBody: {
                            text: body,
                            attributes: [],
                        },
                    },
                },
            },
        },
    };

    const data = await linkedinApi(auth, `/messaging/conversations`, {
        method: "POST",
        body: msgBody,
    });

    return { sent: true, conversationUrn: data.value?.entityUrn || data.entityUrn || null };
}

// ── Reactions & Comments ─────────────────────────────────────────────────────

/** React to a post (like, celebrate, support, love, insightful, funny) */
export async function reactToPost(auth: LinkedInAuth, postUrn: string, reactionType: string = "LIKE"): Promise<any> {
    // LinkedIn reactions need an activity URN. Convert if we got an update/ugcPost URN.
    // urn:li:ugcPost:123 → urn:li:activity:123
    // urn:li:share:123 → urn:li:activity:123
    let activityUrn = postUrn;
    if (postUrn.includes(":ugcPost:")) {
        activityUrn = postUrn.replace(":ugcPost:", ":activity:");
    } else if (postUrn.includes(":share:")) {
        activityUrn = postUrn.replace(":share:", ":activity:");
    }

    await linkedinApi(auth, `/feed/normReactions`, {
        method: "POST",
        body: {
            reactionType: reactionType.toUpperCase(),
            threadUrn: activityUrn,
        },
    });

    return { reacted: true, type: reactionType.toUpperCase(), postUrn: activityUrn };
}

/** Comment on a post */
export async function commentOnPost(auth: LinkedInAuth, postUrn: string, text: string): Promise<any> {
    let authorUrn = "";
    try {
        const me = await getMe(auth);
        const urn = me.objectUrn || me.entityUrn || "";
        if (urn.includes("urn:li:member:")) authorUrn = urn.replace("urn:li:member:", "urn:li:person:");
        else if (urn.includes("urn:li:fsd_profile:")) authorUrn = urn.replace("urn:li:fsd_profile:", "urn:li:person:");
        else if (urn.includes("urn:li:person:")) authorUrn = urn;
        else if (urn) authorUrn = `urn:li:person:${urn.split(":").pop()}`;
    } catch {}

    const body: any = {
        threadUrn: postUrn,
        commentary: {
            text,
            attributes: [],
        },
    };
    if (authorUrn) body.author = authorUrn;

    const data = await linkedinApi(auth, `/feed/normComments`, {
        method: "POST",
        body,
    });

    return { commented: true, urn: data.urn || data.value?.urn || null };
}

/** Get comments on a post via GraphQL */
export async function getPostComments(auth: LinkedInAuth, postUrn: string, count = 20): Promise<any[]> {
    // Extract the activity ID from various URN formats
    let activityUrn = postUrn;
    if (postUrn.includes(":ugcPost:")) activityUrn = postUrn.replace(":ugcPost:", ":activity:");
    else if (postUrn.includes(":share:")) activityUrn = postUrn.replace(":share:", ":activity:");
    // Strip fsd_update wrapper if present: urn:li:fsd_update:(urn:li:activity:XXX,...) → urn:li:activity:XXX
    const activityMatch = activityUrn.match(/urn:li:activity:\d+/);
    if (activityMatch) activityUrn = activityMatch[0];

    // Build the socialDetailUrn — LinkedIn uses (activity,activity,highlightedReply:-) format.
    // encodeURIComponent skips parens, so we encode those manually too.
    const encodedSocialDetail = encodeURIComponent(
        `urn:li:fsd_socialDetail:(${activityUrn},${activityUrn},urn:li:highlightedReply:-)`
    ).replace(/\(/g, "%28").replace(/\)/g, "%29");

    const data = await linkedinApi(auth, `/graphql`, {
        params: {
            variables: `(count:${count},numReplies:0,socialDetailUrn:${encodedSocialDetail},sortOrder:RELEVANCE,start:0)`,
            queryId: "voyagerSocialDashComments.afec6d88d7810d45548797a8dac4fb87",
        },
    });

    const included: any[] = data?.included || [];

    // Build URN map
    const byUrn = new Map<string, any>();
    for (const item of included) {
        const urn = item.entityUrn;
        if (urn) byUrn.set(urn, item);
    }

    const comments: any[] = [];
    for (const item of included) {
        if (comments.length >= count) break;
        // Comment entities have commentary field
        const isComment = item.$type?.includes("Comment") || item.commentary;
        if (!isComment) continue;

        const commentText = item.commentary?.text?.text
            || item.commentary?.text
            || item.comment?.values?.[0]?.value
            || "";
        if (!commentText) continue;

        // Resolve commenter — may be inline object or URN reference
        const commenterInline = typeof item.commenter === "object" ? item.commenter : null;
        const commenterRef = item["*commenter"];
        const commenter = commenterInline || (commenterRef ? byUrn.get(commenterRef) : null);
        const authorName = commenter?.title?.text
            || `${commenter?.firstName || ""} ${commenter?.lastName || ""}`.trim()
            || "";

        comments.push({
            text: commentText.slice(0, 500),
            author: authorName,
            likes: item.socialDetail?.totalSocialActivityCounts?.numLikes || item.numLikes || 0,
            created: item.createdAt ? new Date(item.createdAt).toISOString() : null,
            urn: item.entityUrn || "",
        });
    }

    return comments;
}

// ── Notifications ────────────────────────────────────────────────────────────

/** Get recent notifications */
export async function getNotifications(auth: LinkedInAuth, count = 20): Promise<any[]> {
    const data = await linkedinApi(auth, `/voyagerIdentityDashNotificationCards`, {
        params: {
            decorationId: "com.linkedin.voyager.dash.deco.identity.notifications.CardsCollectionWithInjectionsNoPills-24",
            count: String(count),
            q: "filterVanityName",
        },
    });

    // Normalized response: elements may be in data.elements, data.data.elements, or included
    const elements: any[] = data?.data?.elements || data?.elements || [];
    const included: any[] = data?.included || [];

    // If elements are URN references, resolve from included
    const byUrn = new Map<string, any>();
    for (const item of included) {
        const urn = item.entityUrn || item.urn;
        if (urn) byUrn.set(urn, item);
    }

    const notifications: any[] = [];
    const candidates = elements.length > 0 ? elements : included.filter((i: any) =>
        i.$type?.includes("NotificationCard") || i.headline || i.headlineText
    );

    for (const raw of candidates) {
        if (notifications.length >= count) break;
        const n = typeof raw === "string" ? (byUrn.get(raw) || {}) : raw;
        if (!n || Object.keys(n).length === 0) continue;

        const headline =
            n.headline?.text ||
            n.headlineText?.text ||
            n.notificationText?.text ||
            n.headline ||
            "";
        if (!headline) continue;

        notifications.push({
            headline,
            description:
                n.subText?.text ||
                n.additionalDescription?.text ||
                n.description?.text ||
                "",
            type: n.notificationType || n.trackingData?.notificationType || n.type || "",
            read: !!n.read,
            createdAt: n.publishedAt ? new Date(n.publishedAt).toISOString() : null,
            actionUrl:
                n.navigationUrl ||
                n.cta?.navigationUrl ||
                n.actions?.[0]?.actionTarget ||
                "",
        });
    }

    return notifications;
}

// ── Connection Requests ──────────────────────────────────────────────────────

/** Send a connection request */
export async function sendConnectionRequest(auth: LinkedInAuth, vanityName: string, message?: string): Promise<any> {
    // Resolve vanity name to a profile URN
    const data = await linkedinApi(auth, `/identity/dash/profiles`, {
        params: { q: "memberIdentity", memberIdentity: vanityName },
    });
    const included: any[] = data.included || [];
    const profileEntity = included.find((e: any) => e.$type?.includes("Profile") && e.entityUrn);
    if (!profileEntity?.entityUrn) throw new Error(`Could not find profile for "${vanityName}"`);

    const targetUrn = profileEntity.entityUrn;

    const body: any = {
        inviteeProfileUrn: targetUrn,
    };
    if (message) {
        body.customMessage = message;
    }

    await linkedinApi(auth, `/relationships/invitations`, {
        method: "POST",
        body,
    });

    return { sent: true, to: vanityName };
}

/** Get pending connection requests (received) */
export async function getInvitations(auth: LinkedInAuth, count = 20): Promise<any[]> {
    const data = await linkedinApi(auth, `/relationships/invitationViews`, {
        params: {
            count: String(count),
            start: "0",
            q: "receivedInvitation",
        },
    });

    const included: any[] = data.included || [];
    const elements: any[] = data.elements || [];

    // Build URN map
    const byUrn = new Map<string, any>();
    for (const item of included) {
        const urn = item.entityUrn;
        if (urn) byUrn.set(urn, item);
    }

    return elements.slice(0, count).map((inv: any) => {
        const fromRef = inv["*fromMember"] || inv["*genericInviter"];
        const from = fromRef ? byUrn.get(fromRef) : null;
        const fromName = from
            ? `${from.firstName || ""} ${from.lastName || ""}`.trim()
            : "";

        return {
            invitationId: inv.entityUrn || "",
            from: fromName,
            headline: from?.headline || from?.occupation || "",
            message: inv.message || "",
            sentAt: inv.sentTime ? new Date(inv.sentTime).toISOString() : null,
        };
    });
}

/** Accept or decline a connection request */
export async function respondToInvitation(auth: LinkedInAuth, invitationId: string, accept: boolean): Promise<any> {
    // invitationId might be a full URN — extract the numeric part
    const id = invitationId.replace(/.*:/, "");
    const action = accept ? "accept" : "ignore";

    await linkedinApi(auth, `/relationships/invitations/${id}/${action}`, {
        method: "POST",
    });

    return { [action]: true, invitationId: id };
}

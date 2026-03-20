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
    options: { method?: string; body?: any; params?: Record<string, string> } = {}
): Promise<T> {
    const url = new URL(`${VOYAGER}${path}`);
    if (options.params) {
        for (const [k, v] of Object.entries(options.params)) url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {
        "csrf-token": auth.jsessionid,
        "x-restli-protocol-version": "2.0.0",
        "x-li-lang": "en_US",
        "Accept": "application/vnd.linkedin.normalized+json+2.1",
    };

    if (options.body) {
        headers["Content-Type"] = "application/json";
    }

    // Route through browser extension — carries real browser TLS fingerprint
    if (_browserCommand) {
        const result = await _browserCommand("browser_fetch", {
            url: url.toString(),
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

    const response = await fetch(url.toString(), {
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

/** Get the authenticated user's mini-profile (objectUrn, name) */
async function getMe(auth: LinkedInAuth): Promise<{ objectUrn: string; entityUrn: string }> {
    const data = await linkedinApi(auth, `/me`);
    const profile = data.miniProfile || data;
    return {
        objectUrn: profile.objectUrn || "",
        entityUrn: profile.entityUrn || profile.objectUrn || "",
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
    // Get our member URN to filter to own posts only
    let memberUrn = "";
    try {
        const me = await getMe(auth);
        memberUrn = me.objectUrn;
    } catch {}

    const params: Record<string, string> = {
        count: String(count),
        q: "memberShareFeed",
        moduleKey: "memberShareFeed",
        start: "0",
        paginationToken: "",
    };
    if (memberUrn) params.memberUrn = memberUrn;

    const data = await linkedinApi(auth, `/feed/updatesV2`, { params });
    return extractPosts(data, count);
}

/** Get the user's feed */
export async function getFeed(auth: LinkedInAuth, count = 20): Promise<any[]> {
    const data = await linkedinApi(auth, `/feed/updatesV2`, {
        params: {
            count: String(count),
            q: "relevance",
            start: "0",
            paginationToken: "",
        },
    });

    return extractPosts(data, count);
}

function extractPosts(data: any, max: number): any[] {
    // LinkedIn's normalized response puts ALL entities in `included`.
    // engagement data (socialDetail) lives as a separate entity referenced
    // by URN via the "*socialDetail" pointer field on the update entity.
    const included: any[] = data.included || data.elements || [];

    // Build a URN → entity map for cross-referencing
    const byUrn = new Map<string, any>();
    for (const item of included) {
        const urn = item.entityUrn || item.urn || item.updateUrn;
        if (urn) byUrn.set(urn, item);
    }

    const posts: any[] = [];

    for (const item of included) {
        if (posts.length >= max) break;

        // Only process update items (skip authors, social details, etc.)
        const isUpdate = item["$type"]?.includes("UpdateV2")
            || item["$type"]?.includes("update.Update")
            || !!item.updateUrn;
        if (!isUpdate) continue;

        // Extract post text from commentary (several nesting shapes exist)
        const commentary = item.commentary?.text?.text
            || item.commentary?.text
            || item.value?.["com.linkedin.voyager.feed.render.UpdateV2"]?.commentary?.text?.text
            || "";

        if (!commentary) continue;

        // Look up the socialDetail entity by URN reference.
        // LinkedIn stores the reference as "*socialDetail" (a URN pointer).
        const socialDetailUrn = item["*socialDetail"];
        const socialDetail = socialDetailUrn
            ? byUrn.get(socialDetailUrn)
            : item.socialDetail;

        const socialCounts = socialDetail?.totalSocialActivityCounts || {};

        posts.push({
            text: commentary.slice(0, 1000),
            created: item.createdAt ? new Date(item.createdAt).toISOString() : null,
            likes: socialCounts.numLikes || 0,
            comments: socialCounts.numComments || 0,
            reposts: socialCounts.numShares || 0,
            impressions: socialCounts.numImpressions || null,
            urn: item.updateUrn || item.urn,
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
        // objectUrn is like "urn:li:member:12345" — need "urn:li:person:12345" for authoring
        authorUrn = me.objectUrn.replace("urn:li:member:", "urn:li:person:");
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

/** Search for people */
export async function searchPeople(auth: LinkedInAuth, query: string, count = 10): Promise<any[]> {
    const data = await linkedinApi(auth, `/search/dash/clusters`, {
        params: {
            origin: "GLOBAL_SEARCH_HEADER",
            q: "all",
            keywords: query,
            "resultType": "PEOPLE",
            count: String(count),
            start: "0",
        },
    });

    const included = data.included || [];
    return included
        .filter((e: any) => e.firstName || e.title?.text)
        .slice(0, count)
        .map((p: any) => ({
            name: p.title?.text || `${p.firstName} ${p.lastName}`,
            headline: p.headline?.text || p.headline || "",
            publicId: p.publicIdentifier || "",
            location: p.subline?.text || "",
        }));
}

/** Get connections */
export async function getConnections(auth: LinkedInAuth, count = 50): Promise<any[]> {
    const data = await linkedinApi(auth, `/relationships/dash/connections`, {
        params: {
            count: String(count),
            q: "search",
            sortType: "RECENTLY_ADDED",
            start: "0",
        },
    });

    const included = data.included || [];
    return included
        .filter((e: any) => e.firstName)
        .slice(0, count)
        .map((c: any) => ({
            name: `${c.firstName} ${c.lastName}`,
            headline: c.headline || "",
            publicId: c.publicIdentifier || "",
        }));
}

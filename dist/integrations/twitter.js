/**
 * Twitter/X integration via internal GraphQL API.
 * Uses auth_token cookie + ct0 CSRF token extracted from browser.
 *
 * Query IDs and bearer token are extracted at runtime from Twitter's JS bundle
 * because they rotate with every deployment. Cached in memory with 24h TTL.
 */
const MAIN_JS_RE = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[-a-z]*\/main\.[a-f0-9]+\.js/;
let cachedConfig = null;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
/**
 * Extract bearer token and GraphQL query IDs from Twitter's JS bundle.
 * These rotate with every deployment so we can't hardcode them.
 */
async function getTwitterConfig(auth) {
    if (cachedConfig && Date.now() - cachedConfig.extractedAt < CACHE_TTL) {
        return cachedConfig;
    }
    // Step 1: Fetch x.com homepage to find the main JS bundle URL
    const homeRes = await fetch("https://x.com/", {
        headers: {
            "Cookie": `auth_token=${auth.auth_token}; ct0=${auth.csrf_token}`,
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
    });
    const homeHtml = await homeRes.text();
    // Find main JS bundle
    const jsMatch = homeHtml.match(MAIN_JS_RE);
    if (!jsMatch) {
        throw new Error("Could not find Twitter's main JS bundle. Site structure may have changed.");
    }
    // Step 2: Fetch the JS bundle and extract bearer + query IDs
    const jsRes = await fetch(jsMatch[0]);
    const jsText = await jsRes.text();
    // Extract bearer token
    const bearerMatch = jsText.match(/"Bearer (AAAAAAAAAAAAA[A-Za-z0-9%+/=]+)"/);
    if (!bearerMatch) {
        throw new Error("Could not extract bearer token from Twitter's JS bundle.");
    }
    // Extract query IDs: pattern is {queryId:"abc123",operationName:"UserByScreenName",...}
    const queryIds = {};
    const operations = [
        "UserByScreenName", "UserTweets", "HomeTimeline", "CreateTweet",
        "SearchTimeline", "TweetDetail", "Likes", "Followers", "Following",
    ];
    for (const op of operations) {
        // Match patterns like: queryId:"abc123",operationName:"UserByScreenName"
        // or: {queryId:"abc123",operationName:"UserByScreenName",operationType:"query"}
        const re = new RegExp(`queryId:"([^"]+)",operationName:"${op}"`, "g");
        const match = re.exec(jsText);
        if (match) {
            queryIds[op] = match[1];
        }
    }
    if (!queryIds.UserByScreenName) {
        throw new Error("Could not extract GraphQL query IDs from Twitter's JS bundle.");
    }
    cachedConfig = {
        bearer: bearerMatch[1],
        queryIds,
        extractedAt: Date.now(),
    };
    return cachedConfig;
}
/** Invalidate cache to force re-extraction on next call */
function invalidateCache() {
    cachedConfig = null;
}
async function twitterApi(auth, path, options = {}) {
    const config = await getTwitterConfig(auth);
    const url = new URL(`https://x.com/i/api${path}`);
    if (options.params) {
        for (const [k, v] of Object.entries(options.params))
            url.searchParams.set(k, v);
    }
    const headers = {
        "Cookie": `auth_token=${auth.auth_token}; ct0=${auth.csrf_token}`,
        "x-csrf-token": auth.csrf_token,
        "authorization": `Bearer ${config.bearer}`,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
    if (options.body) {
        headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url.toString(), {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    // If 404, query IDs may have rotated — invalidate and let next call re-extract
    if (response.status === 404) {
        invalidateCache();
        throw new Error("Twitter API 404 — query IDs may have rotated. Retry the call.");
    }
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Twitter API ${response.status}: ${text.slice(0, 300)}`);
    }
    return response.json();
}
function graphqlFeatures() {
    return {
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
        creator_subscriptions_tweet_preview_api_enabled: true,
        freedom_of_speech_not_reach_fetch_enabled: true,
        tweetypie_unmention_optimization_enabled: true,
        longform_notetweets_consumption_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        responsive_web_enhance_cards_enabled: false,
        subscriptions_photo_preview_enabled: true,
        subscriptions_video_preview_enabled: true,
        responsive_web_client_urt_actions_enabled: true,
        articles_preview_enabled: true,
        responsive_web_enhance_trends_enabled: true,
    };
}
function extractTweets(data) {
    const tweets = [];
    // Walk every possible instruction path
    const instructionSources = [
        data?.data?.user?.result?.timeline_v2?.timeline?.instructions,
        data?.data?.user?.result?.timeline?.timeline?.instructions,
        data?.data?.home?.home_timeline_urt?.instructions,
        data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions,
        data?.data?.timeline_by_id?.timeline?.instructions,
    ];
    for (const instructions of instructionSources) {
        if (!instructions)
            continue;
        for (const inst of instructions) {
            const entries = inst.entries || inst.moduleItems || [];
            for (const entry of entries) {
                const result = entry.content?.itemContent?.tweet_results?.result
                    || entry.content?.content?.tweetResult?.result
                    || entry.item?.itemContent?.tweet_results?.result;
                if (!result)
                    continue;
                // Handle TweetWithVisibilityResults wrapper
                const tweet = result.__typename === "TweetWithVisibilityResults" ? result.tweet : result;
                if (!tweet?.legacy)
                    continue;
                const legacy = tweet.legacy;
                const user = tweet.core?.user_results?.result?.legacy || {};
                tweets.push({
                    id: legacy.id_str,
                    text: legacy.full_text || legacy.text || "",
                    author: user.screen_name || "",
                    authorName: user.name || "",
                    created: legacy.created_at,
                    likes: legacy.favorite_count || 0,
                    retweets: legacy.retweet_count || 0,
                    replies: legacy.reply_count || 0,
                    quotes: legacy.quote_count || 0,
                    views: typeof tweet.views?.count === "string" ? parseInt(tweet.views.count) : (tweet.views?.count || null),
                    isRetweet: !!legacy.retweeted_status_result,
                });
            }
        }
        if (tweets.length > 0)
            break; // found tweets, stop searching
    }
    return tweets;
}
/** Get user profile by screen name */
export async function getProfile(auth, screenName) {
    const config = await getTwitterConfig(auth);
    const qid = config.queryIds.UserByScreenName;
    if (!qid)
        throw new Error("UserByScreenName query ID not available");
    const data = await twitterApi(auth, `/graphql/${qid}/UserByScreenName`, {
        params: {
            variables: JSON.stringify({ screen_name: screenName, withSafetyModeUserFields: true }),
            features: JSON.stringify(graphqlFeatures()),
        },
    });
    const user = data?.data?.user?.result?.legacy || {};
    return {
        name: user.name,
        screenName: user.screen_name,
        bio: user.description,
        location: user.location,
        followers: user.followers_count,
        following: user.friends_count,
        tweets: user.statuses_count,
        verified: data?.data?.user?.result?.is_blue_verified || false,
        created: user.created_at,
    };
}
/** Get a user's tweets */
export async function getUserTweets(auth, screenName, count = 20) {
    const config = await getTwitterConfig(auth);
    // Get user ID first
    const qidUser = config.queryIds.UserByScreenName;
    if (!qidUser)
        throw new Error("UserByScreenName query ID not available");
    const profile = await twitterApi(auth, `/graphql/${qidUser}/UserByScreenName`, {
        params: {
            variables: JSON.stringify({ screen_name: screenName, withSafetyModeUserFields: true }),
            features: JSON.stringify(graphqlFeatures()),
        },
    });
    const userId = profile?.data?.user?.result?.rest_id;
    if (!userId)
        throw new Error(`User "${screenName}" not found`);
    const qid = config.queryIds.UserTweets;
    if (!qid)
        throw new Error("UserTweets query ID not available");
    const data = await twitterApi(auth, `/graphql/${qid}/UserTweets`, {
        params: {
            variables: JSON.stringify({
                userId,
                count,
                includePromotedContent: false,
                withQuickPromoteEligibilityTweetFields: false,
                withVoice: false,
                withV2Timeline: true,
            }),
            features: JSON.stringify(graphqlFeatures()),
        },
    });
    return extractTweets(data);
}
/** Get home timeline */
export async function getTimeline(auth, count = 20) {
    const config = await getTwitterConfig(auth);
    const qid = config.queryIds.HomeTimeline;
    if (!qid)
        throw new Error("HomeTimeline query ID not available");
    const data = await twitterApi(auth, `/graphql/${qid}/HomeTimeline`, {
        params: {
            variables: JSON.stringify({ count, includePromotedContent: false, withCommunity: true }),
            features: JSON.stringify(graphqlFeatures()),
        },
    });
    return extractTweets(data);
}
/** Post a tweet */
export async function createTweet(auth, text, replyToId) {
    const config = await getTwitterConfig(auth);
    const qid = config.queryIds.CreateTweet;
    if (!qid)
        throw new Error("CreateTweet query ID not available");
    const variables = {
        tweet_text: text,
        dark_request: false,
        media: { media_entities: [], possibly_sensitive: false },
        semantic_annotation_ids: [],
    };
    if (replyToId) {
        variables.reply = { in_reply_to_tweet_id: replyToId, exclude_reply_user_ids: [] };
    }
    const data = await twitterApi(auth, `/graphql/${qid}/CreateTweet`, {
        method: "POST",
        body: {
            variables,
            features: graphqlFeatures(),
            queryId: qid,
        },
    });
    const result = data?.data?.create_tweet?.tweet_results?.result;
    return {
        posted: true,
        id: result?.rest_id || null,
        text: result?.legacy?.full_text || text,
    };
}
/** Search tweets */
export async function searchTweets(auth, query, count = 20, product = "Latest") {
    const config = await getTwitterConfig(auth);
    const qid = config.queryIds.SearchTimeline;
    if (!qid)
        throw new Error("SearchTimeline query ID not available");
    const data = await twitterApi(auth, `/graphql/${qid}/SearchTimeline`, {
        params: {
            variables: JSON.stringify({
                rawQuery: query,
                count,
                querySource: "typed_query",
                product,
            }),
            features: JSON.stringify(graphqlFeatures()),
        },
    });
    return extractTweets(data);
}
//# sourceMappingURL=twitter.js.map
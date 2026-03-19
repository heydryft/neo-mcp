/**
 * Twitter/X integration via internal GraphQL API.
 * Uses auth_token cookie + ct0 CSRF token extracted from browser.
 *
 * Query IDs and bearer token are extracted at runtime from Twitter's JS bundle
 * because they rotate with every deployment. Cached in memory with 24h TTL.
 */
export interface TwitterAuth {
    auth_token: string;
    csrf_token: string;
}
/** Get user profile by screen name */
export declare function getProfile(auth: TwitterAuth, screenName: string): Promise<any>;
/** Get a user's tweets */
export declare function getUserTweets(auth: TwitterAuth, screenName: string, count?: number): Promise<any[]>;
/** Get home timeline */
export declare function getTimeline(auth: TwitterAuth, count?: number): Promise<any[]>;
/** Post a tweet */
export declare function createTweet(auth: TwitterAuth, text: string, replyToId?: string): Promise<any>;
/** Search tweets */
export declare function searchTweets(auth: TwitterAuth, query: string, count?: number, product?: "Latest" | "Top"): Promise<any[]>;

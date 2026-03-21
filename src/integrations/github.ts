/**
 * GitHub integration via REST API v3 + GraphQL API v4.
 * Uses cookies/tokens extracted from browser session via extract_auth("github").
 *
 * Auth: Uses the `user_session` cookie or a PAT token. The browser extension
 * extracts the session cookie when the user is logged into github.com.
 */

export interface GitHubAuth {
    token: string;         // PAT or oauth token
    _cookies?: string;     // full cookie jar from extract_auth
}

// Set by the MCP server at init
let _browserCommand: ((method: string, params: Record<string, any>) => Promise<any>) | null = null;

export function setBrowserCommand(fn: (method: string, params: Record<string, any>) => Promise<any>) {
    _browserCommand = fn;
}

// ── API wrapper ──────────────────────────────────────────────────────────────

async function githubApi<T = any>(
    auth: GitHubAuth,
    path: string,
    options: { method?: string; body?: any; params?: Record<string, string>; accept?: string } = {}
): Promise<T> {
    const url = new URL(path.startsWith("http") ? path : `https://api.github.com${path}`);
    if (options.params) {
        for (const [k, v] of Object.entries(options.params)) url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {
        "Accept": options.accept || "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "neo-mcp/1.0",
    };

    if (auth.token) {
        headers["Authorization"] = `Bearer ${auth.token}`;
    }

    if (options.body) {
        headers["Content-Type"] = "application/json";
    }

    // Route through browser extension if available (for cookie-based auth)
    if (_browserCommand && !auth.token && auth._cookies) {
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
            throw new Error(`GitHub API ${result.status}: ${text.slice(0, 500)}`);
        }
        return result.body as T;
    }

    // Direct fetch with token
    if (auth._cookies && !auth.token) {
        headers["Cookie"] = auth._cookies;
    }

    const response = await fetch(url.toString(), {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`GitHub API ${response.status}: ${text.slice(0, 500)}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("json")) {
        return response.json() as Promise<T>;
    }
    return (await response.text()) as unknown as T;
}

async function graphql(auth: GitHubAuth, query: string, variables?: Record<string, any>): Promise<any> {
    const data = await githubApi(auth, "https://api.github.com/graphql", {
        method: "POST",
        body: { query, variables },
    });
    if (data.errors && data.errors.length > 0) {
        throw new Error(`GraphQL: ${data.errors.map((e: any) => e.message).join("; ")}`);
    }
    return data.data;
}

// ── User / Profile ───────────────────────────────────────────────────────────

export async function getAuthenticatedUser(auth: GitHubAuth): Promise<any> {
    const user = await githubApi(auth, "/user");
    return {
        login: user.login,
        name: user.name,
        bio: user.bio,
        company: user.company,
        location: user.location,
        email: user.email,
        public_repos: user.public_repos,
        followers: user.followers,
        following: user.following,
        created_at: user.created_at,
        avatar_url: user.avatar_url,
        html_url: user.html_url,
    };
}

export async function getUserProfile(auth: GitHubAuth, username: string): Promise<any> {
    const user = await githubApi(auth, `/users/${encodeURIComponent(username)}`);
    return {
        login: user.login,
        name: user.name,
        bio: user.bio,
        company: user.company,
        location: user.location,
        email: user.email,
        public_repos: user.public_repos,
        followers: user.followers,
        following: user.following,
        created_at: user.created_at,
        avatar_url: user.avatar_url,
        html_url: user.html_url,
    };
}

// ── Repos ────────────────────────────────────────────────────────────────────

export async function listMyRepos(auth: GitHubAuth, count = 30, sort: string = "updated"): Promise<any[]> {
    const repos = await githubApi<any[]>(auth, "/user/repos", {
        params: { per_page: String(count), sort, direction: "desc", type: "owner" },
    });
    return repos.map(r => ({
        name: r.full_name,
        description: r.description,
        language: r.language,
        stars: r.stargazers_count,
        forks: r.forks_count,
        open_issues: r.open_issues_count,
        private: r.private,
        updated_at: r.updated_at,
        html_url: r.html_url,
    }));
}

export async function getRepo(auth: GitHubAuth, owner: string, repo: string): Promise<any> {
    const r = await githubApi(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    return {
        name: r.full_name,
        description: r.description,
        language: r.language,
        stars: r.stargazers_count,
        forks: r.forks_count,
        open_issues: r.open_issues_count,
        watchers: r.watchers_count,
        private: r.private,
        default_branch: r.default_branch,
        topics: r.topics,
        license: r.license?.spdx_id,
        created_at: r.created_at,
        updated_at: r.updated_at,
        pushed_at: r.pushed_at,
        html_url: r.html_url,
        clone_url: r.clone_url,
    };
}

export async function searchRepos(auth: GitHubAuth, query: string, count = 20): Promise<any[]> {
    const data = await githubApi<any>(auth, "/search/repositories", {
        params: { q: query, per_page: String(count), sort: "stars", order: "desc" },
    });
    return (data.items || []).map((r: any) => ({
        name: r.full_name,
        description: r.description,
        language: r.language,
        stars: r.stargazers_count,
        forks: r.forks_count,
        open_issues: r.open_issues_count,
        updated_at: r.updated_at,
        html_url: r.html_url,
    }));
}

// ── Issues ───────────────────────────────────────────────────────────────────

export async function listIssues(auth: GitHubAuth, owner: string, repo: string, options: { state?: string; labels?: string; count?: number } = {}): Promise<any[]> {
    const issues = await githubApi<any[]>(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
        params: {
            per_page: String(options.count || 30),
            state: options.state || "open",
            ...(options.labels ? { labels: options.labels } : {}),
        },
    });
    return issues.filter(i => !i.pull_request).map(i => ({
        number: i.number,
        title: i.title,
        state: i.state,
        author: i.user?.login,
        labels: i.labels?.map((l: any) => l.name),
        comments: i.comments,
        created_at: i.created_at,
        updated_at: i.updated_at,
        html_url: i.html_url,
    }));
}

export async function getIssue(auth: GitHubAuth, owner: string, repo: string, number: number): Promise<any> {
    const i = await githubApi(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`);
    return {
        number: i.number,
        title: i.title,
        state: i.state,
        body: i.body,
        author: i.user?.login,
        assignees: i.assignees?.map((a: any) => a.login),
        labels: i.labels?.map((l: any) => l.name),
        milestone: i.milestone?.title,
        comments: i.comments,
        created_at: i.created_at,
        updated_at: i.updated_at,
        closed_at: i.closed_at,
        html_url: i.html_url,
    };
}

export async function createIssue(auth: GitHubAuth, owner: string, repo: string, title: string, body?: string, labels?: string[], assignees?: string[]): Promise<any> {
    const payload: any = { title };
    if (body) payload.body = body;
    if (labels) payload.labels = labels;
    if (assignees) payload.assignees = assignees;

    const i = await githubApi(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
        method: "POST",
        body: payload,
    });
    return { number: i.number, title: i.title, html_url: i.html_url, created: true };
}

export async function commentOnIssue(auth: GitHubAuth, owner: string, repo: string, number: number, body: string): Promise<any> {
    const comment = await githubApi(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`, {
        method: "POST",
        body: { body },
    });
    return { id: comment.id, html_url: comment.html_url, created: true };
}

// ── Pull Requests ────────────────────────────────────────────────────────────

export async function listPRs(auth: GitHubAuth, owner: string, repo: string, options: { state?: string; count?: number } = {}): Promise<any[]> {
    const prs = await githubApi<any[]>(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
        params: {
            per_page: String(options.count || 30),
            state: options.state || "open",
            sort: "updated",
            direction: "desc",
        },
    });
    return prs.map(p => ({
        number: p.number,
        title: p.title,
        state: p.state,
        draft: p.draft,
        author: p.user?.login,
        head: p.head?.ref,
        base: p.base?.ref,
        mergeable: p.mergeable,
        comments: p.comments,
        review_comments: p.review_comments,
        additions: p.additions,
        deletions: p.deletions,
        created_at: p.created_at,
        updated_at: p.updated_at,
        html_url: p.html_url,
    }));
}

export async function getPR(auth: GitHubAuth, owner: string, repo: string, number: number): Promise<any> {
    const p = await githubApi(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`);
    return {
        number: p.number,
        title: p.title,
        body: p.body,
        state: p.state,
        draft: p.draft,
        merged: p.merged,
        author: p.user?.login,
        head: p.head?.ref,
        base: p.base?.ref,
        mergeable: p.mergeable,
        mergeable_state: p.mergeable_state,
        comments: p.comments,
        review_comments: p.review_comments,
        commits: p.commits,
        additions: p.additions,
        deletions: p.deletions,
        changed_files: p.changed_files,
        labels: p.labels?.map((l: any) => l.name),
        requested_reviewers: p.requested_reviewers?.map((r: any) => r.login),
        created_at: p.created_at,
        updated_at: p.updated_at,
        merged_at: p.merged_at,
        html_url: p.html_url,
    };
}

export async function getPRFiles(auth: GitHubAuth, owner: string, repo: string, number: number): Promise<any[]> {
    const files = await githubApi<any[]>(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files`, {
        params: { per_page: "100" },
    });
    return files.map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch?.slice(0, 2000), // truncate large patches
    }));
}

export async function createPR(auth: GitHubAuth, owner: string, repo: string, title: string, head: string, base: string, body?: string, draft?: boolean): Promise<any> {
    const payload: any = { title, head, base };
    if (body) payload.body = body;
    if (draft !== undefined) payload.draft = draft;

    const p = await githubApi(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
        method: "POST",
        body: payload,
    });
    return { number: p.number, title: p.title, html_url: p.html_url, created: true };
}

export async function mergePR(auth: GitHubAuth, owner: string, repo: string, number: number, method: string = "merge", commitMessage?: string): Promise<any> {
    const payload: any = { merge_method: method };
    if (commitMessage) payload.commit_message = commitMessage;

    const result = await githubApi(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`, {
        method: "PUT",
        body: payload,
    });
    return { merged: result.merged, message: result.message, sha: result.sha };
}

// ── Reviews ──────────────────────────────────────────────────────────────────

export async function getPRReviews(auth: GitHubAuth, owner: string, repo: string, number: number): Promise<any[]> {
    const reviews = await githubApi<any[]>(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`);
    return reviews.map(r => ({
        id: r.id,
        user: r.user?.login,
        state: r.state,
        body: r.body,
        submitted_at: r.submitted_at,
    }));
}

export async function createPRReview(auth: GitHubAuth, owner: string, repo: string, number: number, event: string, body?: string): Promise<any> {
    const payload: any = { event }; // APPROVE, REQUEST_CHANGES, COMMENT
    if (body) payload.body = body;

    const r = await githubApi(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`, {
        method: "POST",
        body: payload,
    });
    return { id: r.id, state: r.state, submitted: true };
}

// ── Notifications ────────────────────────────────────────────────────────────

export async function getNotifications(auth: GitHubAuth, count = 30, all = false): Promise<any[]> {
    const notifications = await githubApi<any[]>(auth, "/notifications", {
        params: { per_page: String(count), all: String(all) },
    });
    return notifications.map(n => ({
        id: n.id,
        reason: n.reason,
        unread: n.unread,
        subject_type: n.subject?.type,
        subject_title: n.subject?.title,
        subject_url: n.subject?.url,
        repo: n.repository?.full_name,
        updated_at: n.updated_at,
    }));
}

export async function markNotificationRead(auth: GitHubAuth, threadId: string): Promise<void> {
    await githubApi(auth, `/notifications/threads/${threadId}`, { method: "PATCH" });
}

// ── Search Code ──────────────────────────────────────────────────────────────

export async function searchCode(auth: GitHubAuth, query: string, count = 20): Promise<any[]> {
    const data = await githubApi<any>(auth, "/search/code", {
        params: { q: query, per_page: String(count) },
    });
    return (data.items || []).map((item: any) => ({
        name: item.name,
        path: item.path,
        repo: item.repository?.full_name,
        html_url: item.html_url,
        score: item.score,
    }));
}

export async function searchUsers(auth: GitHubAuth, query: string, count = 20): Promise<any[]> {
    const data = await githubApi<any>(auth, "/search/users", {
        params: { q: query, per_page: String(count) },
    });
    return (data.items || []).map((u: any) => ({
        login: u.login,
        type: u.type,
        html_url: u.html_url,
        avatar_url: u.avatar_url,
        score: u.score,
    }));
}

// ── Stars ────────────────────────────────────────────────────────────────────

export async function starRepo(auth: GitHubAuth, owner: string, repo: string): Promise<void> {
    await githubApi(auth, `/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        method: "PUT",
    });
}

export async function unstarRepo(auth: GitHubAuth, owner: string, repo: string): Promise<void> {
    await githubApi(auth, `/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        method: "DELETE",
    });
}

export async function listStarred(auth: GitHubAuth, count = 30): Promise<any[]> {
    const repos = await githubApi<any[]>(auth, "/user/starred", {
        params: { per_page: String(count), sort: "updated", direction: "desc" },
    });
    return repos.map(r => ({
        name: r.full_name,
        description: r.description,
        language: r.language,
        stars: r.stargazers_count,
        html_url: r.html_url,
    }));
}

// ── Gists ────────────────────────────────────────────────────────────────────

export async function listGists(auth: GitHubAuth, count = 20): Promise<any[]> {
    const gists = await githubApi<any[]>(auth, "/gists", {
        params: { per_page: String(count) },
    });
    return gists.map(g => ({
        id: g.id,
        description: g.description,
        files: Object.keys(g.files),
        public: g.public,
        comments: g.comments,
        created_at: g.created_at,
        updated_at: g.updated_at,
        html_url: g.html_url,
    }));
}

export async function createGist(auth: GitHubAuth, files: Record<string, string>, description?: string, isPublic = false): Promise<any> {
    const filePayload: Record<string, { content: string }> = {};
    for (const [name, content] of Object.entries(files)) {
        filePayload[name] = { content };
    }

    const g = await githubApi(auth, "/gists", {
        method: "POST",
        body: { files: filePayload, description: description || "", public: isPublic },
    });
    return { id: g.id, html_url: g.html_url, created: true };
}

// ── Actions / Workflows ──────────────────────────────────────────────────────

export async function listWorkflowRuns(auth: GitHubAuth, owner: string, repo: string, count = 10): Promise<any[]> {
    const data = await githubApi<any>(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`, {
        params: { per_page: String(count) },
    });
    return (data.workflow_runs || []).map((r: any) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        branch: r.head_branch,
        event: r.event,
        actor: r.actor?.login,
        created_at: r.created_at,
        updated_at: r.updated_at,
        html_url: r.html_url,
    }));
}

export async function getWorkflowRun(auth: GitHubAuth, owner: string, repo: string, runId: number): Promise<any> {
    const r = await githubApi(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`);
    return {
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        branch: r.head_branch,
        event: r.event,
        actor: r.actor?.login,
        run_attempt: r.run_attempt,
        created_at: r.created_at,
        updated_at: r.updated_at,
        html_url: r.html_url,
    };
}

export async function rerunWorkflow(auth: GitHubAuth, owner: string, repo: string, runId: number): Promise<void> {
    await githubApi(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/rerun`, {
        method: "POST",
    });
}

// ── Repo Contents ────────────────────────────────────────────────────────────

export async function getFileContent(auth: GitHubAuth, owner: string, repo: string, path: string, ref?: string): Promise<any> {
    const params: Record<string, string> = {};
    if (ref) params.ref = ref;

    const data = await githubApi(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`, { params });

    if (Array.isArray(data)) {
        // Directory listing
        return data.map((item: any) => ({
            name: item.name,
            type: item.type,
            size: item.size,
            path: item.path,
        }));
    }

    // Single file
    let content = "";
    if (data.content && data.encoding === "base64") {
        content = Buffer.from(data.content, "base64").toString("utf-8");
    }
    return {
        name: data.name,
        path: data.path,
        size: data.size,
        content: content.slice(0, 50000), // cap at 50k chars
        sha: data.sha,
        html_url: data.html_url,
    };
}

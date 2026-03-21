/**
 * Notion integration via internal API.
 * Uses token_v2 cookie extracted from browser session via extract_auth("notion").
 *
 * The internal API is more powerful than the public API — it accesses everything
 * the user can see in their browser, including workspace-level operations.
 */

export interface NotionAuth {
    token_v2: string;
    _cookies?: string;
}

let _browserCommand: ((method: string, params: Record<string, any>) => Promise<any>) | null = null;

export function setBrowserCommand(fn: (method: string, params: Record<string, any>) => Promise<any>) {
    _browserCommand = fn;
}

// ── API wrapper ──────────────────────────────────────────────────────────────

const NOTION_API = "https://www.notion.so/api/v3";

async function notionApi<T = any>(
    auth: NotionAuth,
    endpoint: string,
    body?: any
): Promise<T> {
    const url = `${NOTION_API}/${endpoint}`;
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Cookie": auth._cookies || `token_v2=${auth.token_v2}`,
    };

    // Route through browser extension if available
    if (_browserCommand) {
        const result = await _browserCommand("browser_fetch", {
            url,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : "{}",
            credentials: "include",
        });
        if (result.error) throw new Error(result.error);
        if (!result.ok) {
            const text = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
            throw new Error(`Notion API ${result.status}: ${text.slice(0, 500)}`);
        }
        return result.body as T;
    }

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body || {}),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Notion API ${response.status}: ${text.slice(0, 500)}`);
    }
    return response.json() as Promise<T>;
}

// ── ID utilities ─────────────────────────────────────────────────────────────

/** Convert a Notion URL or dashed UUID to a clean UUID */
function toUuid(idOrUrl: string): string {
    // Handle full URLs
    const urlMatch = idOrUrl.match(/([a-f0-9]{32})(?:\?|$)/);
    if (urlMatch) {
        const hex = urlMatch[1];
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    // Handle dashed UUIDs
    if (idOrUrl.includes("-") && idOrUrl.replace(/-/g, "").length === 32) {
        return idOrUrl;
    }
    // Handle raw hex
    if (/^[a-f0-9]{32}$/.test(idOrUrl)) {
        return `${idOrUrl.slice(0, 8)}-${idOrUrl.slice(8, 12)}-${idOrUrl.slice(12, 16)}-${idOrUrl.slice(16, 20)}-${idOrUrl.slice(20)}`;
    }
    return idOrUrl;
}

// ── Spaces (Workspaces) ──────────────────────────────────────────────────────

export async function getSpaces(auth: NotionAuth): Promise<any[]> {
    const data = await notionApi(auth, "getSpaces", {});
    const spaces: any[] = [];

    for (const userId of Object.keys(data)) {
        const userSpaces = data[userId];
        if (userSpaces?.space) {
            for (const spaceId of Object.keys(userSpaces.space)) {
                const space = userSpaces.space[spaceId]?.value;
                if (space) {
                    spaces.push({
                        id: space.id,
                        name: space.name,
                        domain: space.domain,
                        icon: space.icon,
                        plan_type: space.plan_type,
                        created_time: space.created_time,
                    });
                }
            }
        }
    }
    return spaces;
}

// ── Search ───────────────────────────────────────────────────────────────────

export async function search(auth: NotionAuth, query: string, options: { limit?: number; spaceId?: string; type?: string } = {}): Promise<any[]> {
    // Auto-detect spaceId if not provided
    let spaceId = options.spaceId;
    if (!spaceId) {
        try {
            const spaces = await getSpaces(auth);
            if (spaces.length > 0) spaceId = spaces[0].id;
        } catch {}
    }

    const body: any = {
        type: "BlocksInSpace",
        query,
        limit: options.limit || 20,
        source: "quick_find",
        filters: {
            isDeletedOnly: false,
            excludeTemplates: false,
            navigableBlockContentOnly: false,
            requireEditPermissions: false,
            includePublicPagesWithoutExplicitAccess: false,
            ancestors: [],
            createdBy: [],
            editedBy: [],
            lastEditedTime: {},
            createdTime: {},
            inTeams: [],
            excludeSurrogateCollections: false,
            excludedParentCollectionIds: [],
        },
        sort: { field: "relevance" },
        peopleBlocksToInclude: "all",
        excludedBlockIds: [],
        searchSessionFlowNumber: 1,
        searchSessionId: crypto.randomUUID(),
        recentPagesForBoosting: [],
        ignoresHighlight: false,
    };

    if (spaceId) {
        body.spaceId = spaceId;
    }

    if (options.type) {
        body.filters.type = options.type;
    }

    const data = await notionApi(auth, "search", body);
    const results: any[] = [];
    const recordMap = data.recordMap || {};
    const blocks = recordMap.block || {};

    for (const item of data.results || []) {
        const blockId = item.id;
        const block = blocks[blockId]?.value;
        if (!block) continue;

        results.push({
            id: block.id,
            type: block.type,
            title: extractTitle(block),
            parent_id: block.parent_id,
            space_id: block.space_id,
            created_time: block.created_time ? new Date(block.created_time).toISOString() : null,
            last_edited_time: block.last_edited_time ? new Date(block.last_edited_time).toISOString() : null,
            url: `https://www.notion.so/${block.id.replace(/-/g, "")}`,
            highlight: item.highlight?.text,
        });
    }
    return results;
}

// ── Pages / Blocks ───────────────────────────────────────────────────────────

function extractTitle(block: any): string {
    const props = block.properties;
    if (!props) return "";
    // Title is usually in the "title" property
    const titleProp = props.title;
    if (!titleProp) return "";
    return titleProp.map((chunk: any[]) => chunk[0]).join("");
}

function extractText(richText: any[][]): string {
    if (!richText) return "";
    return richText.map((chunk: any[]) => chunk[0]).join("");
}

function formatBlock(block: any): any {
    return {
        id: block.id,
        type: block.type,
        title: extractTitle(block),
        text: extractText(block.properties?.title || []),
        has_children: block.content && block.content.length > 0,
        children_ids: block.content,
        parent_id: block.parent_id,
        created_time: block.created_time ? new Date(block.created_time).toISOString() : null,
        last_edited_time: block.last_edited_time ? new Date(block.last_edited_time).toISOString() : null,
        url: `https://www.notion.so/${block.id.replace(/-/g, "")}`,
    };
}

export async function getPage(auth: NotionAuth, pageId: string): Promise<any> {
    const id = toUuid(pageId);
    const data = await notionApi(auth, "loadPageChunk", {
        pageId: id,
        limit: 100,
        cursor: { stack: [] },
        chunkNumber: 0,
        verticalColumns: false,
    });

    const blocks = data.recordMap?.block || {};
    const pageBlock = blocks[id]?.value;
    if (!pageBlock) throw new Error(`Page not found: ${pageId}`);

    // Get all child blocks
    const children: any[] = [];
    for (const childId of pageBlock.content || []) {
        const child = blocks[childId]?.value;
        if (child) children.push(formatBlock(child));
    }

    return {
        ...formatBlock(pageBlock),
        children,
    };
}

export async function getBlock(auth: NotionAuth, blockId: string): Promise<any> {
    const id = toUuid(blockId);
    const data = await notionApi(auth, "syncRecordValues", {
        requests: [{ pointer: { table: "block", id }, version: -1 }],
    });

    const block = data.recordMap?.block?.[id]?.value;
    if (!block) throw new Error(`Block not found: ${blockId}`);
    return formatBlock(block);
}

export async function getPageContent(auth: NotionAuth, pageId: string): Promise<string> {
    const id = toUuid(pageId);
    const data = await notionApi(auth, "loadPageChunk", {
        pageId: id,
        limit: 200,
        cursor: { stack: [] },
        chunkNumber: 0,
        verticalColumns: false,
    });

    const blocks = data.recordMap?.block || {};
    const pageBlock = blocks[id]?.value;
    if (!pageBlock) throw new Error(`Page not found: ${pageId}`);

    const lines: string[] = [];
    const title = extractTitle(pageBlock);
    if (title) lines.push(`# ${title}`, "");

    function renderBlock(blockId: string, depth = 0): void {
        const block = blocks[blockId]?.value;
        if (!block) return;

        const indent = "  ".repeat(depth);
        const text = extractText(block.properties?.title || []);

        switch (block.type) {
            case "header":
                lines.push(`${indent}# ${text}`);
                break;
            case "sub_header":
                lines.push(`${indent}## ${text}`);
                break;
            case "sub_sub_header":
                lines.push(`${indent}### ${text}`);
                break;
            case "bulleted_list":
                lines.push(`${indent}- ${text}`);
                break;
            case "numbered_list":
                lines.push(`${indent}1. ${text}`);
                break;
            case "to_do": {
                const checked = block.properties?.checked?.[0]?.[0] === "Yes";
                lines.push(`${indent}- [${checked ? "x" : " "}] ${text}`);
                break;
            }
            case "toggle":
                lines.push(`${indent}▶ ${text}`);
                break;
            case "quote":
                lines.push(`${indent}> ${text}`);
                break;
            case "callout":
                lines.push(`${indent}💡 ${text}`);
                break;
            case "code":
                lines.push(`${indent}\`\`\``, `${indent}${text}`, `${indent}\`\`\``);
                break;
            case "divider":
                lines.push(`${indent}---`);
                break;
            case "text":
            case "page":
            default:
                if (text) lines.push(`${indent}${text}`);
                break;
        }

        // Render children
        for (const childId of block.content || []) {
            renderBlock(childId, depth + 1);
        }
    }

    for (const childId of pageBlock.content || []) {
        renderBlock(childId);
    }

    return lines.join("\n");
}

// ── Create / Update ──────────────────────────────────────────────────────────

export async function createPage(
    auth: NotionAuth,
    parentId: string,
    title: string,
    content?: string
): Promise<any> {
    const parentUuid = toUuid(parentId);
    const newId = crypto.randomUUID();

    const operations: any[] = [
        {
            id: newId,
            table: "block",
            path: [],
            command: "set",
            args: {
                type: "page",
                id: newId,
                parent_id: parentUuid,
                parent_table: "block",
                alive: true,
                properties: {
                    title: [[title]],
                },
            },
        },
        {
            id: parentUuid,
            table: "block",
            path: ["content"],
            command: "listAfter",
            args: { id: newId },
        },
    ];

    // Add text content blocks if provided
    if (content) {
        const lines = content.split("\n").filter(l => l.trim());
        for (const line of lines) {
            const blockId = crypto.randomUUID();
            operations.push(
                {
                    id: blockId,
                    table: "block",
                    path: [],
                    command: "set",
                    args: {
                        type: "text",
                        id: blockId,
                        parent_id: newId,
                        parent_table: "block",
                        alive: true,
                        properties: { title: [[line]] },
                    },
                },
                {
                    id: newId,
                    table: "block",
                    path: ["content"],
                    command: "listAfter",
                    args: { id: blockId },
                }
            );
        }
    }

    await notionApi(auth, "submitTransaction", { operations });

    return {
        id: newId,
        title,
        url: `https://www.notion.so/${newId.replace(/-/g, "")}`,
        created: true,
    };
}

export async function appendBlock(
    auth: NotionAuth,
    pageId: string,
    text: string,
    type: string = "text"
): Promise<any> {
    const parentUuid = toUuid(pageId);
    const blockId = crypto.randomUUID();

    const operations = [
        {
            id: blockId,
            table: "block",
            path: [],
            command: "set",
            args: {
                type,
                id: blockId,
                parent_id: parentUuid,
                parent_table: "block",
                alive: true,
                properties: { title: [[text]] },
            },
        },
        {
            id: parentUuid,
            table: "block",
            path: ["content"],
            command: "listAfter",
            args: { id: blockId },
        },
    ];

    await notionApi(auth, "submitTransaction", { operations });
    return { id: blockId, type, text, created: true };
}

export async function updateBlock(
    auth: NotionAuth,
    blockId: string,
    text: string
): Promise<any> {
    const id = toUuid(blockId);

    const operations = [
        {
            id,
            table: "block",
            path: ["properties", "title"],
            command: "set",
            args: [[text]],
        },
    ];

    await notionApi(auth, "submitTransaction", { operations });
    return { id, text, updated: true };
}

export async function deleteBlock(auth: NotionAuth, blockId: string): Promise<void> {
    const id = toUuid(blockId);

    const operations = [
        {
            id,
            table: "block",
            path: ["alive"],
            command: "set",
            args: false,
        },
    ];

    await notionApi(auth, "submitTransaction", { operations });
}

// ── Databases (Collections) ──────────────────────────────────────────────────

export async function queryDatabase(
    auth: NotionAuth,
    collectionId: string,
    collectionViewId: string,
    options: { limit?: number; query?: string } = {}
): Promise<any> {
    const body: any = {
        collection: {
            id: toUuid(collectionId),
        },
        collectionView: {
            id: toUuid(collectionViewId),
        },
        loader: {
            type: "reducer",
            reducers: {
                collection_group_results: {
                    type: "results",
                    limit: options.limit || 50,
                },
            },
            searchQuery: options.query || "",
        },
    };

    const data = await notionApi(auth, "queryCollection", body);
    const blocks = data.recordMap?.block || {};
    const collection = data.recordMap?.collection || {};

    // Get schema from collection
    const collData = Object.values(collection)[0] as any;
    const schema = collData?.value?.schema || {};

    const results: any[] = [];
    const blockIds = data.result?.reducerResults?.collection_group_results?.blockIds || [];

    for (const id of blockIds) {
        const block = blocks[id]?.value;
        if (!block) continue;

        const props: Record<string, any> = {};
        for (const [propId, propSchema] of Object.entries(schema) as [string, any][]) {
            const raw = block.properties?.[propId];
            if (!raw) continue;

            const name = propSchema.name;
            switch (propSchema.type) {
                case "title":
                    props[name] = extractText(raw);
                    break;
                case "text":
                case "url":
                case "email":
                case "phone_number":
                    props[name] = extractText(raw);
                    break;
                case "number":
                    props[name] = parseFloat(extractText(raw)) || null;
                    break;
                case "select":
                case "status":
                    props[name] = extractText(raw);
                    break;
                case "multi_select":
                    props[name] = extractText(raw).split(",").map(s => s.trim()).filter(Boolean);
                    break;
                case "checkbox":
                    props[name] = raw[0]?.[0] === "Yes";
                    break;
                case "date":
                    props[name] = raw[0]?.[1]?.[0]?.[1]?.start_date || extractText(raw);
                    break;
                default:
                    props[name] = extractText(raw);
            }
        }

        results.push({
            id: block.id,
            properties: props,
            url: `https://www.notion.so/${block.id.replace(/-/g, "")}`,
            created_time: block.created_time ? new Date(block.created_time).toISOString() : null,
            last_edited_time: block.last_edited_time ? new Date(block.last_edited_time).toISOString() : null,
        });
    }

    return {
        total: blockIds.length,
        results,
        schema: Object.fromEntries(
            Object.entries(schema).map(([id, s]: [string, any]) => [s.name, { id, type: s.type }])
        ),
    };
}

// ── Recently visited ─────────────────────────────────────────────────────────

export async function getRecentPages(auth: NotionAuth, limit = 20): Promise<any[]> {
    // Get the user's space to query recent pages
    let spaceId: string | undefined;
    try {
        const spaces = await getSpaces(auth);
        if (spaces.length > 0) spaceId = spaces[0].id;
    } catch {}

    if (!spaceId) throw new Error("Could not determine workspace. Make sure you're logged into Notion.");

    const data = await notionApi(auth, "getUserSharedPagesInSpace", {
        spaceId,
        includeDeleted: false,
    });

    const pages: any[] = [];
    const ids = data.pages || data.pageIds || [];
    for (const id of ids.slice(0, limit)) {
        const pageId = typeof id === "string" ? id : id.id;
        pages.push({
            id: pageId,
            url: `https://www.notion.so/${(pageId || "").replace(/-/g, "")}`,
        });
    }
    return pages;
}

# Browser & API Discovery

> No pre-built integration needed — these work on any site you're logged into.

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `extract_auth` | Extract auth tokens from the user's logged-in browser session. Supports: slack, discord, linkedin, twitter, github, notion, or any domain. Tokens are stored automatically for future API calls. Use the profile parameter to store credentials under a named profile (e.g. profile='business' stores as 'linkedin:business'). | `service` |
| `authenticated_fetch` | Make an HTTP request from the browser's context, carrying the page's cookies, auth, and session. Works on ANY website the user is logged into.  This is the meta-tool for building integrations on the fly. If no pre-built tool exists for a service: 1. Use discover_api to find the site's API endpoints 2. Use authenticated_fetch to call them 3. Use collection_create to save the discovered API pattern (endpoint, method, headers) so you can reuse it next time without rediscovering | `url`, `method?`, `headers?`, `body?` |
| `network_capture` | Start/stop/clear network request capture in the browser. Use network_requests to list and network_request_detail to inspect. | `action`, `filters?`, `navigate?` |
| `network_requests` | List captured network requests. Returns id, method, status, URL. Use network_request_detail to get full headers/body for a specific request. | `filter?`, `limit?` |
| `network_request_detail` | Get full details for a captured request — request headers, response headers, and body. Pass the id from network_requests. | `id` |
| `bridge_status` | Check if the Neo Browser Bridge extension is connected. | — |
| `web_scrape` | Extract structured data from any URL. Returns clean, parsed content instead of raw HTML. Extracts: page title, meta description, main text content, all links, tables (as arrays), images, OpenGraph/meta tags, and JSON-LD structured data. Use this instead of authenticated_fetch when you need usable data from a page. | `url`, `extract?`, `selector?` |
| `diff_monitor` | Monitor any URL or API endpoint for changes. Stores snapshots in a collection, compares against the previous snapshot, and reports what changed. Use for: price tracking, job posting changes, competitor monitoring, stock availability, or any "tell me when X changes" request. | `action`, `url?`, `name?`, `selector?`, `extract?` |
<!-- AUTO-GENERATED:END -->

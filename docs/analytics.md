# Analytics

> Track and monitor engagement across LinkedIn and Twitter posts over time.

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `content_monitor` | Fetch analytics on your recent posts for a service (linkedin or twitter). Returns engagement rates, best performing posts, and totals. For Twitter, pass your screen_name (handle) to fetch your own tweets. | `service`, `screen_name?`, `count?` |
| `track_post` | Add a post to the analytics tracking collection for ongoing monitoring. Stores current engagement metrics in the neo_analytics collection. | `service`, `post_id`, `post_url?`, `post_text?`, `likes?`, `comments?`, `shares?`, `impressions?` |
| `analytics_report` | Generate a summary report of all tracked posts' performance. Shows engagement totals, averages, and top performers. Uses the neo_analytics collection. | `service?` |
<!-- AUTO-GENERATED:END -->

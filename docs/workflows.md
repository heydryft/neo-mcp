# Workflows

> Pre-built multi-step workflows that combine tools.

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `repurpose_content` | Repurpose content between social media platforms (LinkedIn ↔ Twitter). Analyzes the input text and transforms it to match the target platform's conventions, character limits, formatting style, and audience expectations. Returns ready-to-post content. | `text`, `from`, `to`, `tone?`, `include_hashtags?` |
| `meeting_prep` | Prepare for a meeting by pulling LinkedIn profiles of all attendees from a Google Calendar event. Returns attendee names, roles, companies, headlines, and profile URLs so you're fully briefed before any call. | `event_id`, `calendar_id?`, `gcal_profile?`, `linkedin_profile?` |
| `smart_inbox` | Unified notification inbox across all connected platforms. Returns a single view of what needs your attention: GitHub PRs/issues, LinkedIn messages, Slack DMs, Gmail unreads, and upcoming calendar events. | `github_profile?`, `linkedin_profile?`, `gcal_profile?`, `gmail_profile?` |
| `contact_enrich` | Enrich a contact by searching across LinkedIn, Twitter, GitHub, and Notion. Given a name or email, returns all matching profiles with roles, bios, and links. | `name?`, `email?`, `linkedin_profile?` |
| `content_calendar` | Manage a cross-platform content calendar. Store draft posts, schedule them via Google Calendar, and track what's been published. Uses a 'content_calendar' collection to persist drafts. | `action`, `text?`, `platform?`, `draft_id?`, `schedule_time?`, `gcal_profile?` |
| `pr_digest` | Get a digest of your GitHub activity: open PRs needing review, your PRs with pending reviews, failing CI, and recent issues. Optionally post a summary to a Slack channel. | `github_profile?`, `slack_profile?`, `slack_channel?`, `repos?` |
| `discover_api` | Discover a website's internal API by navigating to it and capturing network requests. This automates the API discovery workflow: 1. Extracts auth tokens from the target site 2. Starts network capture and navigates to the specified URL 3. Waits for API requests to load 4. Returns all captured API endpoints with their methods, URLs, status codes, and headers 5. Suggests which endpoints are useful and how to call them  Use this as the first step when building a new integration for ANY website. | `url`, `service?`, `filters?`, `wait_seconds?` |
<!-- AUTO-GENERATED:END -->

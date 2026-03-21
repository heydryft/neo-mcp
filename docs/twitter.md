# Twitter/X

> *"Extract my Twitter auth and show me my recent tweets"*

Bearer tokens and GraphQL query IDs are extracted automatically from Twitter's JS bundle — they rotate on every deploy so they can't be hardcoded.

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `twitter_profile` | Get a Twitter/X user's profile. | `screen_name` |
| `twitter_user_tweets` | Get a user's tweets with engagement metrics. | `screen_name`, `count?` |
| `twitter_timeline` | Get your home timeline. | `count?` |
| `twitter_post` | Post a tweet. Optionally reply to another tweet. | `text`, `reply_to?` |
| `twitter_search` | Search tweets. | `query`, `count?` |
<!-- AUTO-GENERATED:END -->

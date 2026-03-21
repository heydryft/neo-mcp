# LinkedIn

> *"Extract my LinkedIn auth and get my recent posts with engagement metrics"*

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `linkedin_profile` | Get a LinkedIn user's profile. Pass the vanity name (URL slug, e.g. 'nirupambhowmick'). | `vanity_name` |
| `linkedin_my_posts` | Get your own LinkedIn posts with engagement metrics (likes, comments, reposts, impressions). | `count?` |
| `linkedin_profile_posts` | Get a LinkedIn user's posts by their vanity name (URL slug). | `vanity_name`, `count?` |
| `linkedin_feed` | Get your LinkedIn feed. | `count?` |
| `linkedin_post` | Create a LinkedIn post. | `text` |
| `linkedin_search` | Search for people on LinkedIn. | `query`, `count?` |
| `linkedin_connections` | List your LinkedIn connections. | `count?` |
| `linkedin_conversations` | List your recent LinkedIn message conversations. | `count?` |
| `linkedin_messages` | Get messages in a specific LinkedIn conversation. Pass the conversationId from linkedin_conversations. | `conversation_id`, `count?` |
| `linkedin_send_message` | Send a LinkedIn message to a connection. Pass their profile URN or vanity name (URL slug). | `recipient`, `message` |
| `linkedin_react` | React to a LinkedIn post (like, celebrate, support, love, insightful, funny). | `post_urn`, `reaction?` |
| `linkedin_comment` | Comment on a LinkedIn post. | `post_urn`, `text` |
| `linkedin_post_comments` | Get comments on a LinkedIn post. | `post_urn`, `count?` |
| `linkedin_notifications` | Get your recent LinkedIn notifications. | `count?` |
| `linkedin_send_connection` | Send a connection request to a LinkedIn user. | `vanity_name`, `message?` |
| `linkedin_invitations` | Get your pending connection requests (received). | `count?` |
| `linkedin_respond_invitation` | Accept or decline a pending connection request. | `invitation_id`, `accept` |
<!-- AUTO-GENERATED:END -->

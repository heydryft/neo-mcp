# Slack

> *"Extract my Slack auth and show me unread messages"*

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `slack_channels` | List Slack channels. | — |
| `slack_channel_info` | Get details about a Slack channel. | `channel` |
| `slack_read` | Read messages from a Slack channel. | `channel`, `limit?`, `oldest?`, `latest?` |
| `slack_thread` | Read a Slack thread. | `channel`, `thread_ts`, `limit?` |
| `slack_dms` | Read recent DMs. | `limit?` |
| `slack_search` | Search Slack messages. | `query`, `limit?`, `sort?` |
| `slack_send` | Send a message to a Slack channel or DM. | `channel`, `text`, `thread_ts?` |
| `slack_react` | Add a reaction emoji to a message. | `channel`, `timestamp`, `emoji` |
| `slack_unreact` | Remove a reaction from a message. | `channel`, `timestamp`, `emoji` |
| `slack_edit` | Edit a Slack message. | `channel`, `timestamp`, `text` |
| `slack_delete` | Delete a Slack message. | `channel`, `timestamp` |
| `slack_users` | List Slack workspace users. | — |
| `slack_user_profile` | Get a Slack user's profile. | `user_id` |
| `slack_set_status` | Set your Slack status. | `text`, `emoji?`, `expiration?` |
| `slack_create_channel` | Create a Slack channel. | `name`, `is_private?` |
| `slack_archive_channel` | Archive a Slack channel. | `channel` |
| `slack_invite` | Invite users to a channel. | `channel`, `user_ids` |
| `slack_kick` | Remove a user from a channel. | `channel`, `user_id` |
| `slack_set_topic` | Set a channel's topic. | `channel`, `topic` |
| `slack_set_purpose` | Set a channel's purpose. | `channel`, `purpose` |
| `slack_pin` | Pin a message. | `channel`, `timestamp` |
| `slack_unpin` | Unpin a message. | `channel`, `timestamp` |
| `slack_pins` | List pinned messages in a channel. | `channel` |
<!-- AUTO-GENERATED:END -->

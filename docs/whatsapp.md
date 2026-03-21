# WhatsApp

> *"Connect to WhatsApp"* → scan the QR code → connected forever

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `whatsapp_connect` | Connect to WhatsApp. Opens a QR code in the browser on first use. Auto-reconnects after that. | — |
| `whatsapp_chats` | List WhatsApp chats with last message and unread count. | `limit?` |
| `whatsapp_search_chats` | Search WhatsApp chats by name. | `query`, `limit?` |
| `whatsapp_read` | Read messages from a WhatsApp chat with pagination and search. | `chat`, `limit?`, `offset?`, `query?`, `before?` |
| `whatsapp_search` | Search messages across all WhatsApp chats by text content. | `query`, `chat?`, `limit?` |
| `whatsapp_send` | Send a WhatsApp text message. | `to`, `text` |
| `whatsapp_send_media` | Send media (image, video, document, audio, sticker) on WhatsApp. | `to`, `type`, `url`, `caption?`, `filename?`, `mimetype?` |
| `whatsapp_send_location` | Send a location on WhatsApp. | `to`, `latitude`, `longitude`, `name?` |
| `whatsapp_send_contact` | Send a contact card on WhatsApp. | `to`, `contact_name`, `contact_phone` |
| `whatsapp_check_number` | Check if a phone number is on WhatsApp. | `phone` |
| `whatsapp_find_contact` | Search contacts by name or phone number. | `query` |
| `whatsapp_profile_pic` | Get profile picture URL for a contact or group. | `chat` |
| `whatsapp_status` | Get a contact's status/bio. | `chat` |
| `whatsapp_update_status` | Update your WhatsApp status/bio. | `status` |
| `whatsapp_presence` | Send presence update (typing indicator, online, etc.). | `type`, `chat?` |
| `whatsapp_add_contact` | Create or update a contact. | `phone`, `name` |
| `whatsapp_chat_modify` | Archive, unarchive, mute, unmute, pin, or unpin a chat. | `chat`, `action` |
| `whatsapp_star` | Star or unstar messages. | `chat`, `message_ids`, `star` |
| `whatsapp_mark_read` | Mark a chat as read. | `chat` |
| `whatsapp_block` | Block a contact. | `chat` |
| `whatsapp_unblock` | Unblock a contact. | `chat` |
| `whatsapp_blocklist` | List all blocked contacts. | — |
| `whatsapp_group_info` | Get group metadata (members, description, settings). | `group` |
| `whatsapp_group_create` | Create a new WhatsApp group. | `name`, `participants` |
| `whatsapp_group_participants` | Add, remove, promote, or demote group members. | `group`, `participants`, `action` |
| `whatsapp_group_update_name` | Change a group's name. | `group`, `name` |
| `whatsapp_group_update_description` | Change a group's description. | `group`, `description` |
| `whatsapp_groups_list` | List all groups you're participating in. | — |
| `whatsapp_group_invite` | Get the invite link for a group. | `group` |
| `whatsapp_group_leave` | Leave a WhatsApp group. | `group` |
| `whatsapp_newsletter_create` | Create a new WhatsApp channel. | `name`, `description?` |
| `whatsapp_newsletter_follow` | Follow a WhatsApp channel. | `jid` |
| `whatsapp_newsletter_unfollow` | Unfollow a WhatsApp channel. | `jid` |
| `whatsapp_newsletter_messages` | Get messages from a WhatsApp channel. | `jid`, `count?` |
| `whatsapp_newsletter_info` | Get info about a WhatsApp channel. | `jid` |
| `whatsapp_business_profile` | Get a business profile. | `chat` |
| `whatsapp_catalog` | Get a business's product catalog. | `chat`, `limit?` |
<!-- AUTO-GENERATED:END -->

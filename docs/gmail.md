# Gmail

> *"Connect my Gmail"* → OAuth sign-in → connected

Gmail uses OAuth 2.0. Default credentials are included — just call `gmail_connect` and sign in. See [Gmail OAuth Setup](../README.md#gmail-oauth-setup) for custom credentials.

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `gmail_connect` | Connect a Gmail account via OAuth. Opens Google sign-in in the browser. Use profile to connect multiple accounts. | — |
| `gmail_profile` | Get Gmail profile info (email, message count). | — |
| `gmail_inbox` | Read your Gmail inbox. | `query?`, `max_results?`, `page_token?` |
| `gmail_search` | Search Gmail messages. | `query`, `max_results?`, `page_token?` |
| `gmail_read` | Read a specific email message. | `message_id` |
| `gmail_thread` | Read an entire email thread. | `thread_id` |
| `gmail_send` | Send an email. | `to`, `subject`, `body`, `cc?`, `bcc?`, `thread_id?` |
| `gmail_reply` | Reply to the last message in a thread. | `thread_id`, `body` |
| `gmail_draft` | Create a draft email. | `to`, `subject`, `body`, `cc?`, `bcc?`, `thread_id?` |
| `gmail_mark_read` | Mark an email as read. | `message_id` |
| `gmail_archive` | Archive an email (remove from inbox). | `message_id` |
| `gmail_trash` | Move an email to trash. | `message_id` |
| `gmail_star` | Star an email. | `message_id` |
| `gmail_labels` | List all Gmail labels. | — |
| `gmail_label_create` | Create a Gmail label. | `name` |
| `gmail_modify` | Add or remove labels from a message. | `message_id`, `add_labels?`, `remove_labels?` |
<!-- AUTO-GENERATED:END -->

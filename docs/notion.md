# Notion

> *"Extract my Notion auth and list my pages"*

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `notion_spaces` | List your Notion workspaces. | — |
| `notion_search` | Search Notion pages and databases. | `query`, `limit?`, `type?` |
| `notion_page` | Get a Notion page with its child blocks. | `page_id` |
| `notion_page_content` | Get a Notion page's content as readable markdown text. | `page_id` |
| `notion_block` | Get a specific Notion block. | `block_id` |
| `notion_create_page` | Create a new Notion page. | `parent_id`, `title`, `content?` |
| `notion_append` | Append a block to a Notion page. | `page_id`, `text`, `type?` |
| `notion_update_block` | Update the text of a Notion block. | `block_id`, `text` |
| `notion_delete_block` | Delete a Notion block. | `block_id` |
| `notion_database` | Query a Notion database (collection). | `collection_id`, `view_id`, `limit?`, `query?` |
| `notion_recent` | Get your recently visited Notion pages. | `limit?` |
<!-- AUTO-GENERATED:END -->

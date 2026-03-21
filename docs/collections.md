# Structured Data Storage

> Claude can create its own database tables to store anything it collects.

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `collection_create` | Create a new data collection (SQLite table with FTS). Design your own schema — columns with types (text, number, boolean, date, json). Use this to store structured data you've gathered. | `name`, `description`, `columns` |
| `collection_insert` | Insert a row into a collection. | `collection`, `data` |
| `collection_query` | Query a collection. Supports full-text search, where filters, ordering, and pagination. | `collection`, `search?`, `where?`, `order_by?`, `limit?`, `offset?` |
| `collection_list` | List all collections with their schemas. | — |
| `collection_update` | Update a row in a collection by ID. | `collection`, `id`, `data` |
| `collection_delete` | Delete a row from a collection by ID. | `collection`, `id` |
<!-- AUTO-GENERATED:END -->

# Google Drive

> *"Connect my Google Drive and list my files"*

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `gdrive_connect` | Connect a Google Drive account via OAuth. | — |
| `gdrive_files` | List files in Google Drive. | `query?`, `folder_id?`, `page_size?`, `order_by?` |
| `gdrive_file` | Get file metadata. | `file_id` |
| `gdrive_search` | Search files by name. | `query`, `page_size?` |
| `gdrive_read` | Read file content (Google Docs→text, Sheets→CSV, others→download). | `file_id` |
| `gdrive_create` | Create a file in Google Drive. | `name`, `content`, `mime_type?`, `folder_id?` |
| `gdrive_update` | Update a file's content. | `file_id`, `content`, `mime_type?` |
| `gdrive_delete` | Move a file to trash. | `file_id` |
| `gdrive_create_folder` | Create a folder. | `name`, `parent_id?` |
| `gdrive_shared_drives` | List shared drives. | — |
| `gdrive_quota` | Get storage quota. | — |
<!-- AUTO-GENERATED:END -->

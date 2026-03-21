# GitHub

> *"Extract my GitHub auth"*

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `github_me` | Get your authenticated GitHub profile. | — |
| `github_user` | Get a GitHub user's profile. | `username` |
| `github_repos` | List your GitHub repos. | `count?`, `sort?` |
| `github_repo` | Get details about a GitHub repo. | `owner`, `repo` |
| `github_search_repos` | Search GitHub repositories. | `query`, `count?` |
| `github_issues` | List issues for a repo. | `owner`, `repo`, `state?`, `labels?`, `count?` |
| `github_issue` | Get a specific issue. | `owner`, `repo`, `number` |
| `github_create_issue` | Create a GitHub issue. | `owner`, `repo`, `title`, `body?`, `labels?`, `assignees?` |
| `github_comment_issue` | Comment on a GitHub issue or PR. | `owner`, `repo`, `number`, `body` |
| `github_prs` | List pull requests for a repo. | `owner`, `repo`, `state?`, `count?` |
| `github_pr` | Get details about a pull request. | `owner`, `repo`, `number` |
| `github_pr_files` | Get files changed in a pull request. | `owner`, `repo`, `number` |
| `github_create_pr` | Create a pull request. | `owner`, `repo`, `title`, `head`, `base`, `body?`, `draft?` |
| `github_merge_pr` | Merge a pull request. | `owner`, `repo`, `number`, `method?`, `commit_message?` |
| `github_pr_reviews` | Get reviews on a pull request. | `owner`, `repo`, `number` |
| `github_review_pr` | Submit a review on a pull request. | `owner`, `repo`, `number`, `event`, `body?` |
| `github_notifications` | Get your GitHub notifications. | `count?`, `all?` |
| `github_mark_notification_read` | Mark a notification as read. | `thread_id` |
| `github_search_code` | Search code on GitHub. | `query`, `count?` |
| `github_search_users` | Search GitHub users. | `query`, `count?` |
| `github_starred` | List your starred repos. | `count?` |
| `github_star` | Star a repo. | `owner`, `repo` |
| `github_unstar` | Unstar a repo. | `owner`, `repo` |
| `github_gists` | List your gists. | `count?` |
| `github_create_gist` | Create a gist. | `files`, `description?`, `public?` |
| `github_actions` | List recent workflow runs for a repo. | `owner`, `repo`, `count?` |
| `github_action_run` | Get details about a workflow run. | `owner`, `repo`, `run_id` |
| `github_rerun_workflow` | Re-run a failed workflow. | `owner`, `repo`, `run_id` |
| `github_file` | Get file or directory contents from a repo. | `owner`, `repo`, `path`, `ref?` |
<!-- AUTO-GENERATED:END -->

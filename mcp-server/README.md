# JobWatch MCP Server

This MCP server provides tools to interact with the JobWatch project's Firestore data, allowing AI assistants (like Claude) to analyze your job tracking information.

## 🛠️ Available Tools

- **`list_feeds`**: List all active job boards and companies you are tracking.
- **`get_recent_jobs`**: Fetch the most recent job listings across all sources.
- **`search_jobs`**: Search for specific jobs by title or company.
- **`get_sync_status`**: Check the history and success of recent job sync runs.
- **`trigger_sync`**: Manually trigger a fresh job sync from AI chat.

## 🚀 Setup & Installation

### 1. Requirements
- Node.js installed on your machine.
- A **Firebase Service Account JSON key**. 

### 2. Find your User ID (UID)
To access your specific data, you need your unique JobWatch UID:
1.  Log in to your **JobWatch** web application.
2.  Go to the **Profile** page.
3.  Copy the **User ID (UID)** shown in the Personal Information section.

### 3. Configure Claude Desktop
Add the following to your `claude_desktop_config.json` (located at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "jobwatch": {
      "command": "node",
      "args": ["/Users/akash_ramasani/Desktop/Projects/web_applications/vite/job-watch/mcp-server/index.js"],
      "env": {
        "USER_ID": "YOUR_UID_FROM_PROFILE_PAGE",
        "SERVICE_ACCOUNT_PATH": "/path/to/your/service-account.json"
      }
    }
  }
}
```

## 🧪 Example Questions to Ask
- *"Show me my newest jobs from the last hour."*
- *"Are any of my job feeds failing to sync?"*
- *"Trigger a manual sync and let me know if any new NVIDIA roles appear."*

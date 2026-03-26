# 🤖 JobWatch MCP Server

This standalone **Model Context Protocol (MCP)** server allows you to connect your JobWatch job data directly to AI assistants like **Claude Desktop**. 

It enables natural language queries against your job listings, sync history, and feed configurations.

---

## 🛠️ Available AI Tools

- **`list_feeds`**: View all active job boards and companies currently being tracked.
- **`get_recent_jobs`**: Fetch the most recent job listings across all synchronized sources.
- **`search_jobs`**: Search for specific roles by title, company, or keyword.
- **`get_sync_status`**: Check the health and results of recent automated job sync runs.
- **`trigger_sync`**: Manually initiate a fresh job scrape across all boards from your AI chat.

---

## 🚀 Setup & Installation

### 1. Requirements
- **Node.js**: Installed on your local machine.
- **Firebase Service Account**: A `.json` key file from your Firebase console (Project Settings > Service Accounts).

### 2. Identify your User ID (UID)
To access your specific data securely, you need your unique JobWatch UID:
1.  Log in to the **JobWatch** web app.
2.  Go to the **Profile** page.
3.  Copy your **User ID (UID)** from the Personal Information section.

### 3. Configure Claude Desktop
Add the following configuration to your `claude_desktop_config.json`:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "jobwatch": {
      "command": "node",
      "args": ["/Users/akash_ramasani/Desktop/Projects/web_applications/vite/job-watch/mcp-server/index.js"],
      "env": {
        "USER_ID": "REPLACE_WITH_YOUR_UID",
        "SERVICE_ACCOUNT_PATH": "/path/to/your/service-account.json"
      }
    }
  }
}
```

---

## 🛡️ Security Note
> [!CAUTION]
> **Never commit your `service-account.json` to GitHub.** 
> This project is pre-configured with `.gitignore` to prevent sensitive files from being pushed, but always triple-check that your keys remain local.

---

## 🧪 Example AI Prompts
- *"Are there any new Senior Frontend roles at NVIDIA from today?"*
- *"Check if our Microsoft job scraper ran successfully this morning."*
- *"Summarize the last 5 jobs added to my dashboard."*

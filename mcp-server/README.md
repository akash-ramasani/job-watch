# 🤖 JobWatch MCP Server

A standalone **Model Context Protocol (MCP)** server that connects your JobWatch job data to AI assistants such as **Claude Desktop**, **Claude Code** or **Cursor**.

It exposes the same tools the in-app "JobWatch AI" chat uses (`functions/lib/assistantTools.cjs`), so both answer the same questions the same way: jobs by state, city or metro, remote, time window, title keywords, company, job type, and your personal match score.

---

## 🛠️ Tools

| Tool | What it answers |
| --- | --- |
| `get_assistant_briefing` | Who you are, what JobWatch tracks, the current Pacific time and answer conventions. Call once per conversation. |
| `search_jobs` | "Latest jobs in California in the past 24 hours", "remote backend roles this week", "my best matches at Nvidia". Filters: `state`, `city` (Seattle, Bay Area, NYC, DC area…), `remote`, `postedWithinHours`, `keywords`, `company`, `jobTypes`, `minScore`, `onlyRelevantToMe`, `sortBy` (newest / score), `limit`, `offset`. |
| `job_stats` | "How many jobs came in today?", "which states / companies / job types have the most?", jobs per day. Same filters plus `groupBy`. |
| `get_job_details` | Everything about one job: description, your requirement-by-requirement coverage, visa notes, links. |
| `get_my_profile` | What JobWatch knows about you: titles, years, skills, targeted job types, location, sponsorship need, score distribution. |
| `list_tracked_companies` | Which career sites are tracked; "do you track Stripe?". |
| `get_sync_status` | When jobs were last refreshed and how recent syncs went. |
| `update_memory` | Remember or forget a note about you (preferences, interviews in progress) for future conversations. |

Jobs are kept for 3 days after they are posted, so the widest useful window is `postedWithinHours: 168`.

---

## 🚀 Setup

### 1. Requirements
- **Node.js 22+**.
- Dependencies installed in both `mcp-server/` and `functions/` (`npm install` in each; the tools module lives in `functions/lib`).
- A **Firebase service account** JSON key (Firebase console → Project settings → Service accounts).

### 2. Your user ID
Log in to JobWatch, open **Profile**, and copy your **User ID (UID)**. Without it the server uses the admin account.

### 3. Configure Claude Desktop
Add to `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "jobwatch": {
      "command": "node",
      "args": ["/Users/akash_ramasani/Desktop/Projects/personal/job-watch/mcp-server/index.js"],
      "env": {
        "USER_ID": "REPLACE_WITH_YOUR_UID",
        "SERVICE_ACCOUNT_PATH": "/path/to/your/service-account.json"
      }
    }
  }
}
```

For Claude Code: `claude mcp add jobwatch -e USER_ID=... -e SERVICE_ACCOUNT_PATH=... -- node /Users/akash_ramasani/Desktop/Projects/personal/job-watch/mcp-server/index.js`

---

## 🛡️ Security
> [!CAUTION]
> Never commit `service-account.json`. It is git-ignored, but check before pushing.

---

## 🧪 Example prompts
- *"What software engineering jobs were posted in California in the past 24 hours?"*
- *"Anything in Seattle this week? Only remote."*
- *"Which companies posted the most jobs today?"*
- *"Show my strongest matches (80+) from the last 3 days, then tell me more about the second one."*
- *"Do you track Anthropic? When did the last sync run?"*
- *"Remember that I only want backend roles in the Bay Area."*

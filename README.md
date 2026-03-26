# 🕵️‍♂️ JobWatch

JobWatch is a modern, high-performance job tracking and scraping platform built with **React 19**, **Vite**, and **Firebase**. It empowers job seekers by automating the monitoring of company job boards, filtering for specific locations/roles, and providing real-time push notifications.

---

## 🚀 Key Features

- **🤖 Native AI Assistant**: An integrated, Claude-powered chat assistant that can query your job data, summarize sync runs, and perform smart searches directly in-app.
- **⚡ Automated Scraping**: Periodically monitors job boards (Greenhouse, Ashby, Eightfold, Microsoft, etc.) for new postings.
- **💬 Rich Markdown Support**: Assistant responses include beautifully rendered tables, lists, and formatted text.
- **🌎 Localized Experience**: All job timestamps and sync logs are automatically localized to **Pacific Time (PT)**.
- **🔔 Real-time Notifications**: Native OS-level push notifications via Firebase Cloud Messaging (FCM).
- **📊 Sync Analytics**: Interactive charts powered by **Recharts** to visualize job ingestion trends over time.
- **🛠️ MCP Server**: Includes a Model Context Protocol server to connect your data to external AI tools like Claude Desktop.

---

## 🤖 AI Assistant (In-App & MCP)

JobWatch features a dual-layer AI integration:

### 1. In-App Assistant
Click the floating chat bubble in the bottom-right corner to talk to your data instantly. 
- *"What are the 5 newest Microsoft jobs?"*
- *"When was the last successful sync?"*
- *"Summarize today's job market trends."*

### 2. Model Context Protocol (MCP)
For developers, a standalone MCP server is included in `mcp-server/`. Connect it to **Claude Desktop** to query your Firestore data using natural language from your desktop.

**See [mcp-server/README.md](./mcp-server/README.md) for setup details.**

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19, Vite, Tailwind CSS, Framer Motion |
| **Backend** | Firebase Cloud Functions (Gen 2), Node.js |
| **Database** | Firebase Firestore |
| **AI Brain** | Anthropic Claude 3.5/4.6 Sonnet |
| **Analytics** | Recharts |
| **Tooling** | Model Context Protocol (MCP) |

---

## 📁 Project Structure

- `src/`: React frontend with modular routing and state management.
- `functions/`: Firebase Cloud Functions for scheduled scraping and AI backend.
- `mcp-server/`: Standalone MCP server for third-party AI integration.
- `public/`: Assets and Service Worker configuration.

---

## 🛠️ Getting Started

1.  **Clone the repo**: `git clone ...`
2.  **Install dependencies**: `npm install`
3.  **Setup Firebase**: Add your `.env` file with Firebase credentials.
4.  **Backend Keys**: Set `CLAUDE_API_KEY` in `functions/.env` or via Firebase Secrets.
5.  **Run Dev Server**: `npm run dev`

---

## 📄 License
MIT

# 🕵️‍♂️ JobWatch

JobWatch is a modern, high-performance job tracking and scraping platform built with **React 19**, **Vite**, and **Firebase**. It empowers job seekers by automating the monitoring of company job boards, filtering for specific locations/roles, and providing real-time push notifications.

---

## 🚀 Key Features

- **Automated Scraping**: Periodically monitors job boards (Greenhouse, Ashby, Eightfold, Microsoft, etc.) for new postings.
- **Smart Filtering**: Built-in US city/state and "Remote" detection to keep your feed relevant.
- **Real-time Notifications**: Native OS-level push notifications via Firebase Cloud Messaging (FCM).
- **Personal Dashboard**: Manage multiple job feeds, track sync history, and search through thousands of collected listings.
- **Premium UI**: Sleek, glassmorphic design built with Framer Motion and Tailwind CSS.

---

## 🤖 AI Assistant Integration (MCP)

This project includes a **Model Context Protocol (MCP)** server that allows you to connect JobWatch directly to AI assistants like **Claude Desktop**.

### Why use it?
- **Natural Language Search**: *"Show me the newest jobs at NVIDIA that were posted today."*
- **System Monitoring**: *"When was the last successful sync? Did any feeds fail?"*
- **Actionable AI**: *"Trigger a fresh job sync and summarize the results."*

**Check out the [mcp-server/README.md](./mcp-server/README.md) for full setup instructions.**

---

## 📁 Project Structure

- `src/`: React frontend with modular routing and state management.
- `functions/`: Firebase Cloud Functions (Gen 2) for scheduled job scraping and push logic.
- `mcp-server/`: The Model Context Protocol server for AI assistant connectivity.
- `public/`: Assets and Service Worker configuration.

---

## 🛠️ Getting Started

1.  **Clone the repo**: `git clone ...`
2.  **Install dependencies**: `npm install`
3.  **Setup Firebase**: Add your `.env` file with Firebase credentials (see `.env.example`).
4.  **Run Dev Server**: `npm run dev`

---

## 📄 License
MIT

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const admin = require("firebase-admin");
const path = require("path");

// Configuration from environment variables
const USER_ID = process.env.USER_ID || "7Tojjo8l5PZIYctPmdwncf7PC133"; // Fallback for your account
const SERVICE_ACCOUNT_PATH = process.env.SERVICE_ACCOUNT_PATH || path.join(__dirname, "service-account.json");

// Initialize Firebase Admin
const serviceAccount = require(SERVICE_ACCOUNT_PATH);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

const server = new Server(
  {
    name: "jobwatch-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * List of available tools
 */
const TOOLS = [
  {
    name: "list_feeds",
    description: "List all active job feeds/companies for the user.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_recent_jobs",
    description: "Fetch recent jobs across all feeds.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of jobs to fetch (default: 20)" },
      },
    },
  },
  {
    name: "search_jobs",
    description: "Search for jobs by title or company name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (title or company)" },
        limit: { type: "number", description: "Number of results (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_sync_status",
    description: "Get the status of the latest job sync runs.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of latest runs (default: 5)" },
      },
    },
  },
  {
    name: "trigger_sync",
    description: "Manually trigger a job sync run for the user.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_feeds": {
        const feedsSnap = await db
          .collection("users")
          .doc(USER_ID)
          .collection("feeds")
          .where("archivedAt", "==", null)
          .get();

        const feeds = feedsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        return {
          content: [{ type: "text", text: JSON.stringify(feeds, null, 2) }],
        };
      }

      case "get_recent_jobs": {
        const limit = args.limit || 20;
        const jobsSnap = await db
          .collection("users")
          .doc(USER_ID)
          .collection("jobs")
          .orderBy("sourceUpdatedTs", "desc")
          .limit(limit)
          .get();

        const jobs = jobsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        return {
          content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }],
        };
      }

      case "search_jobs": {
        const query = (args.query || "").toLowerCase();
        const limit = args.limit || 10;

        // Simple client-side search since Firestore doesn't support full-text search easily
        const jobsSnap = await db
          .collection("users")
          .doc(USER_ID)
          .collection("jobs")
          .orderBy("sourceUpdatedTs", "desc")
          .limit(100) // Fetch recent 100 and filter
          .get();

        const jobs = jobsSnap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(j =>
            (j.title && j.title.toLowerCase().includes(query)) ||
            (j.companyName && j.companyName.toLowerCase().includes(query))
          )
          .slice(0, limit);

        return {
          content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }],
        };
      }

      case "get_sync_status": {
        const limit = args.limit || 5;
        const runsSnap = await db
          .collection("users")
          .doc(USER_ID)
          .collection("syncRuns")
          .orderBy("startedAt", "desc")
          .limit(limit)
          .get();

        const runs = runsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        return {
          content: [{ type: "text", text: JSON.stringify(runs, null, 2) }],
        };
      }

      case "trigger_sync": {
        const projectID = serviceAccount.project_id;
        const url = `https://us-central1-${projectID}.cloudfunctions.net/runSyncNow?userId=${USER_ID}`;

        const response = await fetch(url);
        const result = await response.json();

        return {
          content: [{ type: "text", text: `Sync triggered successfully. Result: ${JSON.stringify(result, null, 2)}` }],
        };
      }

      default:
        throw new Error(`Tool not found: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("JobWatch MCP server running on stdio");
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

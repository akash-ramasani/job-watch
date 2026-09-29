/**
 * JobWatch MCP server (stdio). Exposes the same tools the in-app JobWatch AI
 * uses (functions/lib/assistantTools.cjs) to Claude Desktop, Cursor, etc.
 *
 * Env:
 *   USER_ID               whose scores / profile / memory to use (default: the admin)
 *   SERVICE_ACCOUNT_PATH  Firebase service-account JSON (default: ./service-account.json)
 */
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const admin = require("firebase-admin");
const path = require("path");
const { createAssistantContext, runTool, toolsForMcp, buildSystemPrompt, ADMIN_UID } = require("../functions/lib/assistantTools.cjs");

const USER_ID = process.env.USER_ID || ADMIN_UID;
const SERVICE_ACCOUNT_PATH = process.env.SERVICE_ACCOUNT_PATH || path.join(__dirname, "service-account.json");

const serviceAccount = require(SERVICE_ACCOUNT_PATH);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const server = new Server(
  { name: "jobwatch-mcp-server", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// One extra tool for MCP clients: the same briefing the web chat gets as its
// system prompt (who the user is, what JobWatch knows, how to answer).
const BRIEFING_TOOL = {
  name: "get_assistant_briefing",
  description: "How to act as the user's JobWatch assistant: who they are, what JobWatch tracks, current Pacific time, and answer conventions. Call once at the start of a conversation.",
  inputSchema: { type: "object", properties: {} },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [BRIEFING_TOOL, ...toolsForMcp()],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const ctx = createAssistantContext(db, USER_ID, { adminUid: ADMIN_UID });
  try {
    if (name === BRIEFING_TOOL.name) {
      return { content: [{ type: "text", text: await buildSystemPrompt(ctx) }] };
    }
    const result = await runTool(ctx, name, args || {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      ...(result && result.error ? { isError: true } : {}),
    };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`JobWatch MCP server running on stdio (user ${USER_ID})`);
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

// A minimal real MCP server over stdio, for connection-manager tests. Behavior is env-driven so one
// fixture covers the happy path, a slow path (single-flight timing), a tool that errors, and a
// missing-secret assertion.
//   FAKE_DELAY_MS   — delay before responding to callTool (default 0)
//   FAKE_REQUIRE_ENV — if set, the server exits non-zero at startup unless that env var is present
//                      (simulates a real server that dies without its token)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const required = process.env.FAKE_REQUIRE_ENV;
if (required && !process.env[required]) {
  process.stderr.write(`fake server: missing ${required}\n`);
  process.exit(1);
}
const delay = Number(process.env.FAKE_DELAY_MS ?? 0);

const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({
  // The installed SDK (^1.29) validates listTools results against ListToolsResultSchema, which
  // requires an inputSchema object per tool (not optional, despite the brief's skeleton omitting
  // it) — an empty object schema satisfies it without constraining the test's call arguments.
  tools: [
    { name: "read_thing", description: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    { name: "write_thing", description: "write", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
    { name: "boom", description: "always fails", inputSchema: { type: "object" } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  if (req.params.name === "boom") throw new Error("tool exploded");
  return { content: [{ type: "text", text: JSON.stringify({ echo: req.params.arguments ?? null }) }] };
});
await server.connect(new StdioServerTransport());

// Task 1 live-smoke GATE: does a real ACP adapter (claude-agent-acp) honor a
// CLIENT-provisioned stdio MCP server? Provisions echo-mcp and asks the agent to
// call it. PASS = the agent's session updates include a tool_call for `echo` and
// the message contains the echoed marker. Not shipped.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connectAcpAdapter, stdioMcpServer } from "@agentgem/base";

const here = dirname(fileURLToPath(import.meta.url));
const echoServer = stdioMcpServer("echo", process.execPath, [join(here, "echo-mcp.mjs")]);

const descriptor = { id: "claude-code", name: "Claude Code", command: ["claude-agent-acp"] };
const conn = await connectAcpAdapter(descriptor, { clientName: "agentgem-smoke", permission: "allow" });

const updates = [];
try {
  const session = await conn.open(process.cwd(), { mcpServers: [echoServer] });
  await session.prompt(
    "Use the `echo` tool with text exactly 'PONG42' and then tell me what it returned. You MUST call the echo tool.",
    (u) => updates.push(u),
  );
} finally {
  conn.close();
}

const toolCalls = updates.filter((u) => typeof u?.sessionUpdate === "string" && u.sessionUpdate.startsWith("tool_call"));
const text = updates.filter((u) => u?.sessionUpdate === "agent_message_chunk" && u?.content?.type === "text").map((u) => u.content.text).join("");

console.log("=== TOOL CALLS ===");
console.log(JSON.stringify(toolCalls, null, 2));
console.log("=== AGENT TEXT ===");
console.log(text);
const calledEcho = toolCalls.some((t) => JSON.stringify(t).toLowerCase().includes("echo"));
const sawMarker = /PONG42/.test(text) || toolCalls.some((t) => JSON.stringify(t).includes("PONG42"));
console.log("=== VERDICT ===");
console.log(JSON.stringify({ calledEcho, sawMarker, PASS: calledEcho }, null, 2));
process.exit(calledEcho ? 0 : 3);

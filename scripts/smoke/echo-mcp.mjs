// Throwaway minimal MCP stdio server for the Task 1 live-smoke.
// Dependency-free: newline-delimited JSON-RPC over stdin/stdout (MCP stdio transport).
// Exposes one tool, `echo`, that returns its input text. Not shipped.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "echo-smoke", version: "0.0.1" },
    } });
    return;
  }
  if (method === "notifications/initialized") return; // notification, no reply
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{
      name: "echo",
      description: "Echo the input text back.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    }] } });
    return;
  }
  if (method === "tools/call") {
    const text = params?.arguments?.text ?? "";
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo: ${text}` }] } });
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
});

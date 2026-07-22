// A minimal ndjson JSON-RPC "ACP agent" used by the acpSession integration tests.
// Spawned as `node <script> <mode> [pidfile]`. Modes:
//   ok               — answers initialize (advertising loadSession + session.resume),
//                      session/new, session/resume, session/prompt (one text chunk then
//                      end_turn); exits 0 when stdin ends (the graceful-shutdown path).
//   crash-before-init — writes to stderr and exits 7 before answering anything.
//   ignore-term      — like ok, but ignores SIGTERM and never exits on stdin end,
//                      forcing the SIGKILL rung of the shutdown ladder.
//   load-only        — advertises loadSession only (NO sessionCapabilities.resume), so
//                      openExisting's ladder falls to session/load. session/load replays
//                      two session/update notifications ("replayed-1"/"replayed-2") before
//                      its result — exercising the drop-by-design path (no handler is
//                      registered yet, so acpSession.ts's dispatcher silently drops them).
//                      session/prompt behaves identically to "ok".
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = `
const readline = require("node:readline");
const mode = process.argv[2] || "ok";
if (process.argv[3]) require("node:fs").writeFileSync(process.argv[3], String(process.pid));
if (mode === "crash-before-init") { process.stderr.write("boom: adapter exploded\\n"); process.exit(7); }
if (mode === "ignore-term") { process.on("SIGTERM", () => {}); }
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    const agentCapabilities = mode === "load-only"
      ? { loadSession: true }
      : { loadSession: true, sessionCapabilities: { resume: {} } };
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: msg.params && msg.params.protocolVersion,
      agentCapabilities,
      agentInfo: { name: "fake-adapter", version: "1.0.0" },
    } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-new-1" } });
  } else if (msg.method === "session/resume") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/load") {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed-1" } },
    } });
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed-2" } },
    } });
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from fake" } },
    } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
process.stdin.on("end", () => { if (mode !== "ignore-term") process.exit(0); });
`;

/** Write the fake adapter script into `dir` and return its absolute path. */
export function writeFakeAdapter(dir: string): string {
  const path = join(dir, "fake-acp-adapter.cjs");
  writeFileSync(path, SCRIPT);
  return path;
}

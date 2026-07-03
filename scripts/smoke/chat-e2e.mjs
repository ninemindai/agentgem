// Task 11 END-TO-END live validation: drive the REAL goldmine chat path.
// Real claude-agent-acp + real agentgem-goldmine MCP server + chatConnectFn
// (permission:"deny") + ChatManager + draftGemFromChat. Proves the agent calls
// the goldmine read tools and the draft-a-Gem handoff produces a selection.
// Not shipped.
import { join } from "node:path";
import { ChatManager } from "@agentgem/run";
import { agentgemHome } from "@agentgem/model";
import { chatConnectFn, goldmineMcpServers } from "../../dist/goldmine/chatRoutes.js";
import { draftGemFromChat } from "../../dist/goldmine/draftGem.js";

const neutralCwd = join(agentgemHome(), ".agentgem", "chat");
const brief =
  "You are grounded in the user's local goldmine of coding sessions and installed artifacts. " +
  "You have MCP tools mcp__agentgem-goldmine__search_sessions and mcp__agentgem-goldmine__get_artifact_detail.";

// Mirror the index.ts wiring: force the neutral cwd regardless of what ChatManager passes.
const manager = new ChatManager({
  connectFn: async (descriptor) => {
    const conn = await chatConnectFn(descriptor);
    return { ctx: { open: (_cwd, opts) => conn.ctx.open(neutralCwd, opts) }, close: conn.close };
  },
});

function drain(chatId, message) {
  return (async () => {
    const events = [];
    for await (const ev of manager.sendMessage(chatId, message)) events.push(ev);
    return events;
  })();
}

const chatId = await manager.openChat({
  agentId: "claude-code",
  brief,
  mcpServers: goldmineMcpServers(),
});
console.log("opened chat:", chatId);

// Turn 1: force a goldmine tool call.
const ev1 = await drain(
  chatId,
  "Call the search_sessions tool (query: empty string, limit: 5) to list my recent coding sessions. " +
  "Then tell me how many you found and name one project path. You MUST call the tool.",
);
const tools = ev1.filter((e) => e.type === "tool");
const answer = ev1.filter((e) => e.type === "delta").map((e) => e.text).join("");
const done1 = ev1.find((e) => e.type === "done");
const failed1 = ev1.find((e) => e.type === "failed");

console.log("\n=== TURN 1 ===");
console.log("tool events:", JSON.stringify(tools, null, 2));
console.log("answer:", (done1?.result?.text ?? answer).slice(0, 600));
if (failed1) console.log("FAILED:", failed1.error);

const calledGoldmine = tools.some((t) =>
  /search_sessions|get_artifact_detail|agentgem-goldmine/i.test(JSON.stringify(t)));

// Turn 2 + draft-gem handoff.
console.log("\n=== DRAFT-A-GEM ===");
const draft = await draftGemFromChat({ manager }, chatId);
console.log(JSON.stringify(draft, null, 2).slice(0, 800));
const draftOk = !!draft && !("error" in draft) && !!draft.gem;

manager.closeChat(chatId);

console.log("\n=== VERDICT ===");
console.log(JSON.stringify({
  toolCalled: calledGoldmine,
  gotAnswer: !!(done1?.result?.text),
  draftProducedGem: draftOk,
  PASS: calledGoldmine && !!(done1?.result?.text),
}, null, 2));
process.exit(calledGoldmine && !!(done1?.result?.text) ? 0 : 3);

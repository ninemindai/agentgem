// Task 11 degradation check: goldmine MCP bin points at a NONEXISTENT path.
// The chat must still answer from the pre-injected brief (no crash, no hang).
import { join } from "node:path";
import { ChatManager } from "@agentgem/run";
import { agentgemHome } from "@agentgem/model";
import { stdioMcpServer } from "@agentgem/base";
import { chatConnectFn } from "../../dist/goldmine/chatRoutes.js";

const neutralCwd = join(agentgemHome(), ".agentgem", "chat");
const manager = new ManagerWrap();
function ManagerWrap() {
  return new ChatManager({
    connectFn: async (d) => { const c = await chatConnectFn(d); return { ctx: { open: (_c, o) => c.ctx.open(neutralCwd, o) }, close: c.close }; },
  });
}
const badMcp = [stdioMcpServer("agentgem-goldmine", process.execPath, ["/nonexistent/definitely-not-here.js"])];
const chatId = await manager.openChat({ agentId: "claude-code", brief: "You are a helpful assistant grounded in the user's goldmine. The user has some installed skills.", mcpServers: badMcp });
const events = [];
for await (const ev of manager.sendMessage(chatId, "In one sentence, what can you help me with? Do not call any tools.")) events.push(ev);
manager.closeChat(chatId);
const done = events.find((e) => e.type === "done");
const failed = events.find((e) => e.type === "failed");
console.log("answer:", (done?.result?.text ?? "").slice(0, 300));
console.log("VERDICT:", JSON.stringify({ answered: !!done?.result?.text, failed: failed?.error ?? null, PASS: !!done?.result?.text }));
process.exit(done?.result?.text ? 0 : 3);

// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/chatSession.live.test.ts
//
// Live smoke (gated by AGENTGEM_LIVE, needs claude-agent-acp installed): proves the
// #1 assumption the durable-sessions feature rests on — the sessionId ACP hands back
// over the wire is the SAME id the adapter writes to disk, so it can be used later to
// re-locate the on-disk transcript for restore. Not run in CI.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ChatManager } from "@agentgem/run";
import { chatConnectFn, goldmineMcpServers } from "../../goldmine/chatRoutes.js";
import { loadSessionTranscript } from "@agentgem/insight";

describe.skipIf(!process.env.AGENTGEM_LIVE)("ACP sessionId ↔ on-disk transcript (live)", () => {
  it("session.sessionId names the file inspectSession reads", async () => {
    const cwd = join(homedir(), ".agentgem", "chat");
    const mgr = new ChatManager({ connectFn: async (d) => { const c = await chatConnectFn(d, { permission: "deny" }); return c as any; } });
    const chatId = await mgr.openChat({ agentId: "claude-code", brief: "reply with the single word: ok", mcpServers: goldmineMcpServers(), cwd });
    const sessionId = mgr.stateOf(chatId).alive ? (mgr.stateOf(chatId) as any).sessionId : "";
    expect(sessionId).toBeTruthy();
    for await (const _ of mgr.sendMessage(chatId, "ok")) { /* drive one turn so the adapter flushes the file */ }
    // claude: filename IS the sessionId
    expect(existsSync(join(homedir(), ".claude", "projects", cwd.replace(/[/.]/g, "-"), `${sessionId}.jsonl`))).toBe(true);
    // and our read path resolves it by that id
    const view = await loadSessionTranscript(sessionId, "claude");
    expect(view?.turns.length).toBeGreaterThan(0);
    mgr.closeChat(chatId);
  }, 120_000);
});

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAcpAdapter, type AgentDescriptor } from "@agentgem/base";
import { writeFakeAdapter } from "./fakeAcpAdapter.js";
import { ChatManager, type ChatCtx, type ChatSessionHandle } from "@agentgem/run";

const fixtureDir = mkdtempSync(join(tmpdir(), "agentgem-acp-resume-"));
const adapterPath = writeFakeAdapter(fixtureDir);
const descriptor: AgentDescriptor = { id: "fake", name: "Fake", command: [process.execPath, adapterPath, "ok"] };

describe("openExisting", () => {
  it("resumes a session via session/resume and prompts on it", async () => {
    const conn = await connectAcpAdapter(descriptor, { clientName: "t", permission: "deny" });
    const session = await conn.openExisting(fixtureDir, "sess-prior-42");
    expect(session.sessionId).toBe("sess-prior-42");
    let text = "";
    const stop = await session.prompt("continue", (u) => {
      const up = u as { sessionUpdate?: string; content?: { type?: string; text?: string } };
      if (up?.sessionUpdate === "agent_message_chunk" && up.content?.type === "text") text += up.content.text;
    });
    expect(stop).toBe("end_turn");
    expect(text).toBe("hello from fake");
    conn.close();
  });
  it("throws resume_unsupported when the agent advertises neither method", async () => {
    const conn = await connectAcpAdapter(descriptor, { clientName: "t", permission: "deny" });
    (conn.info.capabilities as Record<string, unknown>).loadSession = false;
    (conn.info.capabilities as Record<string, unknown>).sessionCapabilities = {};
    await expect(conn.openExisting(fixtureDir, "sess-x")).rejects.toMatchObject({ code: "resume_unsupported" });
    conn.close();
  });
});

const mkHandle = (sessionId: string): ChatSessionHandle => ({
  sessionId,
  setMode: async () => {},
  prompt: async (text) => ({ text: `echo:${text}`, toolCalls: [] }),
  dispose: () => {},
});

describe("ChatManager resume", () => {
  it("resumes via openExisting: no brief injection, resumed=true, same sessionId", async () => {
    const prompts: string[] = [];
    const ctx: ChatCtx & { openExisting?: (cwd: string, sid: string) => Promise<ChatSessionHandle> } = {
      open: async () => { throw new Error("must not open a fresh session"); },
      openExisting: async (_cwd, sid) => {
        const h = mkHandle(sid);
        return { ...h, prompt: async (text) => { prompts.push(text); return { text: "ok", toolCalls: [] }; } };
      },
    };
    const mgr = new ChatManager({ connectFn: async () => ({ ctx, close: () => {} }) });
    const chatId = await mgr.openChat({ agentId: "fake", brief: "BRIEF", descriptor: { id: "f", name: "F", command: ["x"] }, resumeSessionId: "sess-old" });
    const st = mgr.stateOf(chatId);
    expect(st).toMatchObject({ alive: true, sessionId: "sess-old", resumed: true });
    for await (const _ of mgr.sendMessage(chatId, "hi")) { /* drain */ }
    expect(prompts).toEqual(["hi"]); // resumed session already has its context — no brief re-injection
  });
  it("falls back to a fresh session when openExisting fails, and injects the brief", async () => {
    const prompts: string[] = [];
    const ctx: ChatCtx & { openExisting?: (cwd: string, sid: string) => Promise<ChatSessionHandle> } = {
      open: async () => ({ ...mkHandle("sess-fresh"), prompt: async (text) => { prompts.push(text); return { text: "ok", toolCalls: [] }; } }),
      openExisting: async () => { throw Object.assign(new Error("nope"), { code: "resume_unsupported" }); },
    };
    const mgr = new ChatManager({ connectFn: async () => ({ ctx, close: () => {} }) });
    const chatId = await mgr.openChat({ agentId: "fake", brief: "BRIEF", descriptor: { id: "f", name: "F", command: ["x"] }, resumeSessionId: "sess-old" });
    expect(mgr.stateOf(chatId)).toMatchObject({ alive: true, sessionId: "sess-fresh", resumed: false });
    for await (const _ of mgr.sendMessage(chatId, "hi")) { /* drain */ }
    expect(prompts[0].startsWith("BRIEF")).toBe(true);
  });
});

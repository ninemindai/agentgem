import { describe, it, expect } from "vitest";
import { ChatManager } from "@agentgem/run";

// Fake agent: one connect → one session; records prompts; emits a scripted update stream.
function fakeConnect(script: (prompt: string) => any[]) {
  let connects = 0; const prompts: string[] = [];
  const fn = async () => {
    connects++;
    const ctx = { open: async () => ({
      setMode: async () => {},
      prompt: async (text: string, onDelta?: (c: string) => void, onTool?: (t: any) => void) => {
        prompts.push(text);
        for (const u of script(text)) {
          if (u.sessionUpdate === "agent_message_chunk") onDelta?.(u.content.text);
          if (u.sessionUpdate === "tool_call") onTool?.({ toolCallId: u.toolCallId, title: u.title, status: u.status });
        }
        return { text: script(text).filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join(""), toolCalls: [] };
      },
      dispose: () => {},
    }) };
    return { ctx, close: () => {} };
  };
  return { fn, stats: () => ({ connects, prompts }) };
}

describe("ChatManager", () => {
  it("multi-turn reuses one session (connect once) and streams events", async () => {
    const fake = fakeConnect((p) => p.includes("hi")
      ? [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } }]
      : [{ sessionUpdate: "tool_call", toolCallId: "t1", title: "search_sessions", status: "completed" },
         { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "found 3" } }]);
    const mgr = new ChatManager({ connectFn: fake.fn as any });
    const id = await mgr.openChat({ agentId: "claude-code", brief: "BRIEF" });

    const ev1: any[] = []; for await (const e of mgr.sendMessage(id, "hi")) ev1.push(e);
    expect(ev1.find((e) => e.type === "delta")?.text).toBe("hello");
    expect(ev1.at(-1).type).toBe("done");

    const ev2: any[] = []; for await (const e of mgr.sendMessage(id, "search")) ev2.push(e);
    expect(ev2.find((e) => e.type === "tool")?.tool.title).toBe("search_sessions");

    expect(fake.stats().connects).toBe(1);                 // one long-lived session
    expect(fake.stats().prompts[0]).toContain("BRIEF");    // brief injected on first turn
    expect(fake.stats().prompts[1]).not.toContain("BRIEF"); // not re-injected after
  });

  it("emits failed (never throws) when the agent errors", async () => {
    const badConnect = async () => ({ ctx: { open: async () => ({ setMode: async () => {}, prompt: async () => { throw new Error("boom"); }, dispose: () => {} }) }, close: () => {} });
    const mgr = new ChatManager({ connectFn: badConnect as any });
    const id = await mgr.openChat({ agentId: "claude-code", brief: "B" });
    const evs: any[] = []; for await (const e of mgr.sendMessage(id, "x")) evs.push(e);
    expect(evs.at(-1)).toMatchObject({ type: "failed", error: "boom" });
  });

  it("delivers partial deltas then failed when the agent dies mid-turn", async () => {
    // Mirrors the ACP child crashing mid-prompt: some output streamed, then prompt() rejects.
    const connect = async () => ({ ctx: { open: async () => ({
      setMode: async () => {},
      prompt: async (_t: string, onDelta?: (c: string) => void) => { onDelta?.("half done"); throw new Error("agent process exited (signal SIGKILL)"); },
      dispose: () => {},
    }) }, close: () => {} });
    const mgr = new ChatManager({ connectFn: connect as any });
    const id = await mgr.openChat({ agentId: "claude-code", brief: "B" });
    const evs: any[] = []; for await (const e of mgr.sendMessage(id, "x")) evs.push(e);
    expect(evs.find((e) => e.type === "delta")?.text).toBe("half done"); // streamed output preserved
    expect(evs.at(-1)).toMatchObject({ type: "failed", error: expect.stringContaining("exited") });
  });

  it("sweepIdle tears down sessions past idleMs", async () => {
    let t = 1000; const fake = fakeConnect(() => [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }]);
    const mgr = new ChatManager({ connectFn: fake.fn as any, now: () => t, idleMs: 100 });
    const id = await mgr.openChat({ agentId: "claude-code", brief: "B" });
    for await (const _ of mgr.sendMessage(id, "hi")) { /* drain */ }
    t = 2000; mgr.sweepIdle();
    const evs: any[] = []; for await (const e of mgr.sendMessage(id, "again")) evs.push(e);
    expect(evs.at(-1)).toMatchObject({ type: "failed" }); // chatId gone after sweep
  });

  it("LRU-evicts beyond maxLive", async () => {
    const fake = fakeConnect(() => []);
    const mgr = new ChatManager({ connectFn: fake.fn as any, maxLive: 1 });
    const a = await mgr.openChat({ agentId: "claude-code", brief: "B" });
    const b = await mgr.openChat({ agentId: "claude-code", brief: "B" });
    const evs: any[] = []; for await (const e of mgr.sendMessage(a, "x")) evs.push(e);
    expect(evs.at(-1)).toMatchObject({ type: "failed" }); // 'a' evicted when 'b' opened
    expect(b).toBeTruthy();
  });

  it("closes the connection if opening the session fails (no leak)", async () => {
    let closed = 0;
    const connectFn = async () => ({
      ctx: { open: async () => { throw new Error("open failed"); } },
      close: () => { closed++; },
    });
    const mgr = new ChatManager({ connectFn: connectFn as any });
    await expect(mgr.openChat({ agentId: "claude-code", brief: "B" })).rejects.toThrow("open failed");
    expect(closed).toBe(1);
  });

  it("rejects with Unknown agentId when agentId is not in the AGENTS registry", async () => {
    const fake = fakeConnect(() => []);
    const mgr = new ChatManager({ connectFn: fake.fn as any });
    await expect(mgr.openChat({ agentId: "does-not-exist", brief: "B" })).rejects.toThrow(/Unknown agentId/);
  });

  it("exposes sessionId + agent via stateOf for a live chat", async () => {
    const connect = async () => ({ ctx: { open: async () => ({
      sessionId: "sess_abc",
      setMode: async () => {},
      prompt: async () => ({ text: "", toolCalls: [] }),
      dispose: () => {},
    }) }, close: () => {} });
    const mgr = new ChatManager({ connectFn: connect as any });
    const id = await mgr.openChat({ agentId: "claude-code", brief: "B" });
    expect(mgr.stateOf(id)).toEqual({ alive: true, running: false, sessionId: "sess_abc", agent: "claude-code" });
    expect(mgr.stateOf("nope")).toEqual({ alive: false });
  });
});

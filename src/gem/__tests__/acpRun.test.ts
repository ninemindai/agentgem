// src/gem/__tests__/acpRun.test.ts
import { describe, it, expect } from "vitest";
import {
  runGemWithAgent, createAccumulator, applyUpdate, setRunConnectFnForTests,
  type RunConnectFn, type RunResult, type ToolInvocation,
} from "../acpRun.js";

const DIR = "/tmp/agentgem-testbed/qa-gem";

// A fake ACP agent: records the cwd/mode/prompt it was driven with, and replays a
// canned RunResult (emitting tool calls + text through the handlers along the way).
// Mirrors the connectFn-injection pattern used by acpRecommender.test.ts.
function fakeAgent(opts: { result?: RunResult; throwConnect?: boolean } = {}) {
  const calls = {
    cwd: null as string | null,
    mode: null as string | null,
    prompted: null as string | null,
    disposed: false,
    closed: false,
  };
  const connectFn: RunConnectFn = async () => {
    if (opts.throwConnect) throw new Error("failed to spawn claude-agent-acp");
    return {
      ctx: {
        async open(cwd: string) {
          calls.cwd = cwd;
          return {
            async setMode(mode: string) { calls.mode = mode; },
            async prompt(
              text: string,
              onDelta?: (c: string) => void,
              onToolCall?: (t: ToolInvocation) => void,
            ): Promise<RunResult> {
              calls.prompted = text;
              const res = opts.result ?? { text: "", toolCalls: [] };
              for (const t of res.toolCalls) onToolCall?.(t);
              if (res.text) onDelta?.(res.text);
              return res;
            },
            dispose() { calls.disposed = true; },
          };
        },
      },
      close() { calls.closed = true; },
    };
  };
  return { connectFn, calls };
}

describe("runGemWithAgent", () => {
  it("opens the session in the provided testbed dir, not a neutral one", async () => {
    const { connectFn, calls } = fakeAgent();
    await runGemWithAgent({ dir: DIR, task: "run the QA flow", connectFn });
    expect(calls.cwd).toBe(DIR);
  });

  it("sets a non-plan mode so the agent can actually invoke tools", async () => {
    const { connectFn, calls } = fakeAgent();
    await runGemWithAgent({ dir: DIR, task: "go", connectFn });
    expect(calls.mode).toBeTruthy();
    expect(calls.mode).not.toBe("plan");
  });

  it("captures the agent's tool invocations and message text", async () => {
    const result: RunResult = {
      text: "Done — ran QA.",
      toolCalls: [
        { toolCallId: "t1", title: "Skill(qa)", kind: "other", status: "completed" },
        { toolCallId: "t2", title: "Bash(npm test)", kind: "execute", status: "completed" },
      ],
    };
    const { connectFn } = fakeAgent({ result });
    const out = await runGemWithAgent({ dir: DIR, task: "go", connectFn });
    expect(out.ok).toBe(true);
    expect(out.result.text).toBe("Done — ran QA.");
    expect(out.result.toolCalls.map((t) => t.title)).toEqual(["Skill(qa)", "Bash(npm test)"]);
  });

  it("streams tool calls and deltas to the caller's handlers", async () => {
    const result: RunResult = {
      text: "hi",
      toolCalls: [{ toolCallId: "t1", title: "Skill(qa)" }],
    };
    const seenTools: string[] = [];
    const seenDeltas: string[] = [];
    const { connectFn } = fakeAgent({ result });
    await runGemWithAgent({
      dir: DIR, task: "go", connectFn,
      onToolCall: (t) => seenTools.push(t.title),
      onDelta: (c) => seenDeltas.push(c),
    });
    expect(seenTools).toEqual(["Skill(qa)"]);
    expect(seenDeltas).toEqual(["hi"]);
  });

  it("returns ok:false with a timeout error when the agent never finishes the prompt", async () => {
    const connectFn: RunConnectFn = async () => ({
      ctx: {
        async open() {
          return {
            async setMode() {},
            prompt() { return new Promise<RunResult>(() => {}); }, // never resolves
            dispose() {},
          };
        },
      },
      close() {},
    });
    const out = await runGemWithAgent({ dir: DIR, task: "go", connectFn, timeoutMs: 20 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/timed out/i);
  });

  it("returns ok:false with the error when the agent can't be spawned (never throws)", async () => {
    const { connectFn } = fakeAgent({ throwConnect: true });
    const out = await runGemWithAgent({ dir: DIR, task: "go", connectFn });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/spawn/i);
    expect(out.result.toolCalls).toEqual([]);
  });

  it("disposes the session and closes the connection", async () => {
    const { connectFn, calls } = fakeAgent();
    await runGemWithAgent({ dir: DIR, task: "go", connectFn });
    expect(calls.disposed).toBe(true);
    expect(calls.closed).toBe(true);
  });

  it("passes the chosen agent descriptor to the connectFn (defaults to Claude)", async () => {
    const seen: string[] = [];
    const connectFn: RunConnectFn = async (descriptor) => {
      seen.push(descriptor.command.join(" "));
      return { ctx: { async open() { return { async setMode() {}, async prompt() { return { text: "", toolCalls: [] }; }, dispose() {} }; } }, close() {} };
    };
    await runGemWithAgent({ dir: DIR, task: "go", connectFn });
    await runGemWithAgent({ dir: DIR, task: "go", connectFn, descriptor: { id: "codex", name: "Codex", command: ["codex-agent-acp"] } });
    expect(seen[0]).toContain("claude-agent-acp");
    expect(seen[1]).toBe("codex-agent-acp");
  });

  it("uses a test-injected connectFn when set, without an explicit opts.connectFn", async () => {
    const { connectFn, calls } = fakeAgent();
    setRunConnectFnForTests(connectFn);
    try {
      const out = await runGemWithAgent({ dir: DIR, task: "go" });
      expect(calls.cwd).toBe(DIR);
      expect(out.ok).toBe(true);
    } finally {
      setRunConnectFnForTests(null);
    }
  });

  it("reports the sandbox backend in the outcome (injected connectFn => not isolated)", async () => {
    setRunConnectFnForTests(async () => ({
      ctx: { open: async () => ({ setMode: async () => {}, prompt: async () => ({ text: "ok", toolCalls: [] }), dispose: () => {} }) },
      close: () => {},
    }));
    try {
      const out = await runGemWithAgent({ dir: "/tmp/whatever", task: "do" });
      expect(out.ok).toBe(true);
      expect(out.sandbox).toEqual({ backend: "injected", isolated: false });
    } finally {
      setRunConnectFnForTests(null);
    }
  });
});

describe("applyUpdate (session-update reducer)", () => {
  it("accumulates agent_message_chunk text and streams deltas", () => {
    const acc = createAccumulator();
    const seen: string[] = [];
    applyUpdate(acc, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } }, { onDelta: (c) => seen.push(c) });
    applyUpdate(acc, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } }, { onDelta: (c) => seen.push(c) });
    expect(acc.text).toBe("Hello");
    expect(seen).toEqual(["Hel", "lo"]);
  });

  it("records a tool_call and fires onToolCall once", () => {
    const acc = createAccumulator();
    const seen: ToolInvocation[] = [];
    applyUpdate(acc, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Write", kind: "edit", status: "pending" }, { onToolCall: (t) => seen.push(t) });
    expect(acc.toolCalls).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].title).toBe("Write");
  });

  it("merges a tool_call_update into the matching tool, advancing its final status", () => {
    const acc = createAccumulator();
    applyUpdate(acc, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Write", kind: "edit", status: "pending" });
    applyUpdate(acc, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    expect(acc.toolCalls).toHaveLength(1);                 // updates merge, not duplicate
    expect(acc.toolCalls[0].status).toBe("completed");     // finding #1: final status, not "pending"
  });

  it("ignores a tool_call_update for an unknown id without crashing", () => {
    const acc = createAccumulator();
    applyUpdate(acc, { sessionUpdate: "tool_call_update", toolCallId: "ghost", status: "completed" });
    expect(acc.toolCalls).toEqual([]);
  });
});

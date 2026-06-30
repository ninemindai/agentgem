// src/__tests__/gemRunStream.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { streamGemRun } from "../gemRunStream.js";
import { registerRun } from "@agentgem/run";
import { setRunConnectFnForTests, type RunConnectFn, type ToolInvocation } from "@agentgem/run";

// Capture the SSE frames a handler writes, parsed back into { event, data } pairs.
function fakeRes() {
  let buf = "";
  const res = {
    status: 0,
    headers: {} as Record<string, string>,
    writeHead(s: number, h: Record<string, string>) { res.status = s; res.headers = h; },
    write(c: string) { buf += c; },
    end() {},
  };
  const events = () => buf.split("\n\n").filter(Boolean).map((frame) => {
    const ev = /event: (.*)/.exec(frame)?.[1] ?? "";
    const data = /data: (.*)/.exec(frame)?.[1] ?? "";
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
  return { res, events };
}

const okAgent: RunConnectFn = async () => ({
  ctx: {
    async open() {
      return {
        async setMode() {},
        async prompt(_t: string, onDelta?: (c: string) => void, onToolCall?: (t: ToolInvocation) => void) {
          onToolCall?.({ toolCallId: "t1", title: "Write(x)", status: "completed" });
          onDelta?.("all done");
          return { text: "all done", toolCalls: [{ toolCallId: "t1", title: "Write(x)", status: "completed" }] };
        },
        dispose() {},
      };
    },
  },
  close() {},
});

afterEach(() => setRunConnectFnForTests(null));

describe("streamGemRun", () => {
  it("streams phase → tool → delta → done with a verification verdict", async () => {
    setRunConnectFnForTests(okAgent);
    const runId = registerRun("/tmp/prepared-run", "claude");
    const { res, events } = fakeRes();
    await streamGemRun({ query: { runId, task: "go", expectTools: "Write" } }, res);

    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    const evs = events();
    const names = evs.map((e) => e.event);
    expect(names).toContain("phase");
    expect(names).toContain("tool");
    expect(names).toContain("delta");
    const done = evs.find((e) => e.event === "done");
    expect(done?.data.run.ok).toBe(true);
    expect(done?.data.verification.passed).toBe(true);
    expect(done?.data.agent).toBe("claude");
  });

  it("emits a single failed event for an unknown runId (never runs an agent)", async () => {
    const { res, events } = fakeRes();
    await streamGemRun({ query: { runId: "bogus", task: "go" } }, res);
    const evs = events();
    expect(evs.map((e) => e.event)).toEqual(["failed"]);
    expect(evs[0].data.message).toMatch(/unknown or expired/i);
  });
});

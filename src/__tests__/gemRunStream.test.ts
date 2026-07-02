// src/__tests__/gemRunStream.test.ts
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamGemRun } from "../gemRunStream.js";
import { registerRun, ledgerPath } from "@agentgem/run";
import { setRunConnectFnForTests, type RunConnectFn, type ToolInvocation } from "@agentgem/run";
import type { GemContract } from "@agentgem/model";

let home: string;
let prevHome: string | undefined;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "agem-stream-home-"));
  prevHome = process.env.AGENTGEM_HOME;
  process.env.AGENTGEM_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  if (prevHome !== undefined) process.env.AGENTGEM_HOME = prevHome;
  else delete process.env.AGENTGEM_HOME;
});

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

  it("falls back to the registry contract for task + expectations, flags contractApplied, and ledgers", async () => {
    setRunConnectFnForTests(okAgent);
    const contract: GemContract = { task: "contract task", expect: { tools: ["Write"] } };
    const runId = registerRun("/tmp/prepared-run", "claude", { gemName: "g", gemDigest: "sha256:d", contract });
    const { res, events } = fakeRes();
    await streamGemRun({ query: { runId } }, res); // no task, no expect* params
    const done = events().find((e) => e.event === "done");
    expect(done?.data.verification.passed).toBe(true);
    expect(done?.data.contractApplied).toBe(true);
    const rec = JSON.parse(readFileSync(ledgerPath(), "utf8").trim().split("\n").at(-1)!);
    expect(rec.gemName).toBe("g");
    expect(rec.gemDigest).toBe("sha256:d");
    expect(rec.agent).toBe("claude");
    expect(rec.contractApplied).toBe(true);
    expect(rec.verification.passed).toBe(true);
  });

  it("explicit query expectations replace the contract's entirely", async () => {
    setRunConnectFnForTests(okAgent);
    const contract: GemContract = { task: "contract task", expect: { text: "never-in-output" } };
    const runId = registerRun("/tmp/prepared-run", "claude", { contract });
    const { res, events } = fakeRes();
    await streamGemRun({ query: { runId, expectTools: "Write" } }, res);
    const done = events().find((e) => e.event === "done");
    // Contract's expectText would fail; the query override must have replaced it wholly.
    expect(done?.data.verification.passed).toBe(true);
    expect(done?.data.contractApplied).toBe(false);
  });

  it("still fails on a missing task when the run has no contract", async () => {
    const runId = registerRun("/tmp/prepared-run", "claude");
    const { res, events } = fakeRes();
    await streamGemRun({ query: { runId } }, res);
    const evs = events();
    expect(evs.map((e) => e.event)).toEqual(["failed"]);
    expect(evs[0].data.message).toMatch(/missing task/i);
  });

  it("runs without verification when neither params nor contract exist (no ledger row)", async () => {
    setRunConnectFnForTests(okAgent);
    const before = existsSync(ledgerPath()) ? readFileSync(ledgerPath(), "utf8").trim().split("\n").length : 0;
    const runId = registerRun("/tmp/prepared-run", "claude");
    const { res, events } = fakeRes();
    await streamGemRun({ query: { runId, task: "go" } }, res);
    const done = events().find((e) => e.event === "done");
    expect(done?.data.verification).toBeUndefined();
    expect(done?.data.contractApplied).toBe(false);
    const after = existsSync(ledgerPath()) ? readFileSync(ledgerPath(), "utf8").trim().split("\n").length : 0;
    expect(after).toBe(before);
  });
});

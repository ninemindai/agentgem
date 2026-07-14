// src/__tests__/gemRunStream.test.ts
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemStreamController } from "../gem.stream.controller.js";
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

// Drive the streamOf generator, collecting the yielded discriminated-union items.
type Ev = { type: string; [k: string]: unknown };
async function run(query: Record<string, string>): Promise<Ev[]> {
  const out: Ev[] = [];
  for await (const e of new GemStreamController().run({ query } as never)) out.push(e as Ev);
  return out;
}
// done nests the rich payload ({runId, agent, run, verification, contractApplied}) under `result`.
const doneResult = (evs: Ev[]) => (evs.find((e) => e.type === "done") as { result: Record<string, unknown> } | undefined)?.result;

afterEach(() => setRunConnectFnForTests(null));

describe("GemStreamController.run (streamOf route)", () => {
  it("streams phase → tool → delta → done with a verification verdict", async () => {
    setRunConnectFnForTests(okAgent);
    const runId = registerRun("/tmp/prepared-run", "claude");
    const evs = await run({ runId, task: "go", expectTools: "Write" });

    const types = evs.map((e) => e.type);
    expect(types).toContain("phase");
    expect(types).toContain("tool");
    expect(types).toContain("delta");
    const res = doneResult(evs) as { run: { ok: boolean }; verification: { passed: boolean }; agent: string };
    expect(res.run.ok).toBe(true);
    expect(res.verification.passed).toBe(true);
    expect(res.agent).toBe("claude");
  });

  it("emits a single failed event for an unknown runId (never runs an agent)", async () => {
    const evs = await run({ runId: "bogus", task: "go" });
    expect(evs.map((e) => e.type)).toEqual(["failed"]);
    expect(evs[0].message).toMatch(/unknown or expired/i);
  });

  it("falls back to the registry contract for task + expectations, flags contractApplied, and ledgers", async () => {
    setRunConnectFnForTests(okAgent);
    const contract: GemContract = { task: "contract task", expect: { tools: ["Write"] } };
    const runId = registerRun("/tmp/prepared-run", "claude", { gemName: "g", gemDigest: "sha256:d", contract });
    const evs = await run({ runId }); // no task, no expect* params
    const res = doneResult(evs) as { verification: { passed: boolean }; contractApplied: boolean };
    expect(res.verification.passed).toBe(true);
    expect(res.contractApplied).toBe(true);
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
    const evs = await run({ runId, expectTools: "Write" });
    const res = doneResult(evs) as { verification: { passed: boolean }; contractApplied: boolean };
    // Contract's expectText would fail; the query override must have replaced it wholly.
    expect(res.verification.passed).toBe(true);
    expect(res.contractApplied).toBe(false);
  });

  it("still fails on a missing task when the run has no contract", async () => {
    const runId = registerRun("/tmp/prepared-run", "claude");
    const evs = await run({ runId });
    expect(evs.map((e) => e.type)).toEqual(["failed"]);
    expect(evs[0].message).toMatch(/missing task/i);
  });

  it("runs without verification when neither params nor contract exist (no ledger row)", async () => {
    setRunConnectFnForTests(okAgent);
    const before = existsSync(ledgerPath()) ? readFileSync(ledgerPath(), "utf8").trim().split("\n").length : 0;
    const runId = registerRun("/tmp/prepared-run", "claude");
    const evs = await run({ runId, task: "go" });
    const res = doneResult(evs) as { verification: unknown; contractApplied: boolean };
    expect(res.verification).toBeUndefined();
    expect(res.contractApplied).toBe(false);
    const after = existsSync(ledgerPath()) ? readFileSync(ledgerPath(), "utf8").trim().split("\n").length : 0;
    expect(after).toBe(before);
  });
});

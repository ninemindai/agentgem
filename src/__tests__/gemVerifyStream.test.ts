// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/gemVerifyStream.test.ts
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemStreamController } from "../gem.stream.controller.js";
import { registerVerify, setRunConnectFnForTests, type RunConnectFn, type ToolInvocation } from "@agentgem/run";
import type { Gem } from "@agentgem/model";

let home: string; let prevHome: string | undefined;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "agem-vstream-"));
  prevHome = process.env.AGENTGEM_HOME;
  process.env.AGENTGEM_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  if (prevHome !== undefined) process.env.AGENTGEM_HOME = prevHome; else delete process.env.AGENTGEM_HOME;
});
afterEach(() => setRunConnectFnForTests(null));

// Drive the streamOf generator. `agent` is top-level on agent-start/tool/delta;
// the verdict event nests it (the whole verdict is a z.unknown() passthrough).
type Ev = { type: string; [k: string]: unknown };
async function verify(verifyId: string): Promise<Ev[]> {
  const out: Ev[] = [];
  for await (const e of new GemStreamController().verify({ query: { verifyId } } as never)) out.push(e as Ev);
  return out;
}
function agentOf(e: Ev): string | undefined {
  if (e.type === "verdict") return (e.verdict as { agent?: string } | undefined)?.agent;
  return e.agent as string | undefined;
}
const seqOf = (evs: Ev[]) => evs.map((e) => e.type + (agentOf(e) ? `:${agentOf(e)}` : ""));

const gem: Gem = {
  name: "mxs-gem", createdFrom: "test",
  artifacts: [{ type: "skill", name: "qa", source: "standalone", content: "# QA" }],
  checks: [], requiredSecrets: [],
  contract: { task: "exercise qa", expect: { tools: ["qa"] } },
};
// claude's run dir invokes the contract tool → passes; codex doesn't → fails.
const splitAgent: RunConnectFn = async () => ({
  ctx: {
    async open(cwd: string) {
      const title = cwd.endsWith("claude") ? "Skill(qa)" : "Bash(ls)";
      return {
        async setMode() {},
        async prompt(_t: string, onDelta?: (c: string) => void, onToolCall?: (t: ToolInvocation) => void) {
          const tool = { toolCallId: "t1", title, status: "completed" };
          onToolCall?.(tool); onDelta?.("done");
          return { text: "done", toolCalls: [tool] };
        },
        dispose() {},
      };
    },
  },
  close() {},
});

describe("GemStreamController.verify (streamOf route)", () => {
  it("streams agent-start/tool/delta/verdict per agent then done with the matrix", async () => {
    setRunConnectFnForTests(splitAgent);
    const verifyId = registerVerify({ gem, baseDir: join(home, "m"), roster: ["claude", "codex"], gemDigest: "sha:d", gemName: gem.name });
    const evs = await verify(verifyId);
    expect(seqOf(evs)).toEqual([
      "agent-start:claude", "tool:claude", "delta:claude", "verdict:claude",
      "agent-start:codex", "tool:codex", "delta:codex", "verdict:codex",
      "done",
    ]);
    const done = evs.at(-1)! as unknown as { gemName: string; gemDigest: string; verdicts: { agent: string; status: string }[] };
    expect(done.gemName).toBe("mxs-gem");
    expect(done.gemDigest).toBe("sha:d");
    expect(done.verdicts.map((v) => `${v.agent}:${v.status}`)).toEqual(["claude:passed", "codex:failed"]);
  });

  it("emits a single failed event for an unknown verifyId", async () => {
    const evs = await verify("bogus");
    expect(evs.map((e) => e.type)).toEqual(["failed"]);
    expect(evs[0].message).toMatch(/unknown or expired/i);
  });

  it("consumes the verifyId one-shot — a replay of the same GET fails instead of re-running the matrix", async () => {
    setRunConnectFnForTests(splitAgent);
    const verifyId = registerVerify({ gem, baseDir: join(home, "m2"), roster: ["claude", "codex"], gemDigest: "sha:d", gemName: gem.name });
    const first = await verify(verifyId);
    expect(first.at(-1)!.type).toBe("done");

    const second = await verify(verifyId);
    expect(second.map((e) => e.type)).toEqual(["failed"]);
    expect(second[0].message).toMatch(/unknown or expired/i);
  });

  it("emits agent-start before verdict even when the agent run itself throws (failed verdict)", async () => {
    // A throwing connectFn exercises the run-FAILURE path: with a test seam present the
    // availability check is skipped, so this yields a "failed" verdict, not "unavailable".
    const throwingAgent: RunConnectFn = async () => { throw new Error("boom mid-run"); };
    setRunConnectFnForTests(throwingAgent);
    const verifyId = registerVerify({ gem, baseDir: join(home, "u"), roster: ["claude"], gemDigest: "sha:x", gemName: gem.name });
    const seq = seqOf(await verify(verifyId));
    const agentStartIdx = seq.indexOf("agent-start:claude");
    const verdictIdx = seq.indexOf("verdict:claude");
    expect(agentStartIdx).toBeGreaterThanOrEqual(0);
    expect(verdictIdx).toBeGreaterThan(agentStartIdx);
  });
});

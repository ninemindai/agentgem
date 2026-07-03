// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/gemVerifyStream.test.ts
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamGemVerify } from "../gemVerifyStream.js";
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

function fakeRes() {
  let buf = "";
  const res = {
    status: 0, headers: {} as Record<string, string>,
    writeHead(s: number, h: Record<string, string>) { res.status = s; res.headers = h; },
    write(c: string) { buf += c; }, end() {},
  };
  const events = () => buf.split("\n\n").filter(Boolean).map((frame) => ({
    event: /event: (.*)/.exec(frame)?.[1] ?? "",
    data: JSON.parse(/data: (.*)/.exec(frame)?.[1] ?? "null"),
  }));
  return { res, events };
}

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

describe("streamGemVerify", () => {
  it("streams agent-start/tool/delta/verdict per agent then done with the matrix", async () => {
    setRunConnectFnForTests(splitAgent);
    const verifyId = registerVerify({ gem, baseDir: join(home, "m"), roster: ["claude", "codex"], gemDigest: "sha:d", gemName: gem.name });
    const { res, events } = fakeRes();
    await streamGemVerify({ query: { verifyId } }, res);
    const evs = events();
    const seq = evs.map((e) => e.event + (e.data?.agent ? `:${e.data.agent}` : ""));
    expect(seq).toEqual([
      "agent-start:claude", "tool:claude", "delta:claude", "verdict:claude",
      "agent-start:codex", "tool:codex", "delta:codex", "verdict:codex",
      "done",
    ]);
    const done = evs.at(-1)!.data;
    expect(done.gemName).toBe("mxs-gem");
    expect(done.gemDigest).toBe("sha:d");
    expect(done.verdicts.map((v: { agent: string; status: string }) => `${v.agent}:${v.status}`)).toEqual(["claude:passed", "codex:failed"]);
  });

  it("emits a single failed event for an unknown verifyId", async () => {
    const { res, events } = fakeRes();
    await streamGemVerify({ query: { verifyId: "bogus" } }, res);
    const evs = events();
    expect(evs.map((e) => e.event)).toEqual(["failed"]);
    expect(evs[0].data.message).toMatch(/unknown or expired/i);
  });

  it("emits agent-start before verdict even for unavailable agents", async () => {
    // connectFn that throws for agents without test setup (unavailable adapter)
    const unavailableAgent: RunConnectFn = async () => {
      throw new Error("adapter not installed");
    };
    setRunConnectFnForTests(unavailableAgent);
    const verifyId = registerVerify({ gem, baseDir: join(home, "u"), roster: ["claude"], gemDigest: "sha:x", gemName: gem.name });
    const { res, events } = fakeRes();
    await streamGemVerify({ query: { verifyId } }, res);
    const evs = events();
    const seq = evs.map((e) => e.event + (e.data?.agent ? `:${e.data.agent}` : ""));
    // agent-start must come before verdict, even on error
    const agentStartIdx = seq.indexOf("agent-start:claude");
    const verdictIdx = seq.indexOf("verdict:claude");
    expect(agentStartIdx).toBeGreaterThanOrEqual(0);
    expect(verdictIdx).toBeGreaterThan(agentStartIdx);
  });
});

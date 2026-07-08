// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { defaultRecallDbPath, serverFunnelDeps } from "../recall.js";

describe("defaultRecallDbPath", () => {
  it("resolves under ~/.agentgem and ends with recall-index.db", () => {
    const p = defaultRecallDbPath();
    expect(p).toMatch(/\.agentgem[/\\]recall-index\.db$/);
  });
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("serverFunnelDeps.synthesize", () => {
  it("streams the injected synth output as deltas over the answered sessions", async () => {
    const seen: string[] = [];
    const deps = serverFunnelDeps({
      // Deltas fire on separate ticks, not synchronously back-to-back, so the
      // generator's queue drains empty between them and the await new
      // Promise(res => wake = res) suspend/wake bridge actually gets hit
      // instead of both chunks landing in the queue before the first pull.
      synthConnect: async (q, onDelta) => {
        onDelta("syn");
        await tick();
        onDelta("thesis");
        return "synthesis";
      },
    });
    const answers = [
      { sessionId: "s1", agent: "claude", answered: true, answer: "did X" },
      { sessionId: "s2", agent: "claude", answered: false, answer: "failed" },
    ];
    let out = "";
    for await (const delta of deps.synthesize(answers, "summarize", "extract", new AbortController().signal)) {
      seen.push(delta); out += delta;
    }
    expect(out).toBe("synthesis");
    expect(seen).toEqual(["syn", "thesis"]);
  });

  it("does not duplicate output with the deterministic join on a mid-stream failure", async () => {
    const deps = serverFunnelDeps({
      synthConnect: async (q, onDelta) => {
        onDelta("partial");
        await tick();
        throw new Error("adapter died mid-stream");
      },
    });
    const answers = [{ sessionId: "s1", agent: "claude", answered: true, answer: "did X" }];
    const seen: string[] = [];
    for await (const delta of deps.synthesize(answers, "summarize", "extract", new AbortController().signal)) {
      seen.push(delta);
    }
    expect(seen).toEqual(["partial"]);
  });
});

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

describe("serverFunnelDeps.synthesize", () => {
  it("streams the injected synth output as deltas over the answered sessions", async () => {
    const seen: string[] = [];
    const deps = serverFunnelDeps({
      synthConnect: async (q, onDelta) => { onDelta("syn"); onDelta("thesis"); return "synthesis"; },
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
});

// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { rerankCandidates, type DiscoverCandidate, type AcpConnectFn } from "@agentgem/insight";

const cand = (name: string, source = "o/r"): DiscoverCandidate => ({
  name, source, registry: "skills.sh", installs: 1,
  url: `https://skills.sh/${source}/${name}`, reason: "orig", installCmd: `npx skills add ${source}@${name}`,
});

// Fake ACP connect: returns a fixed agent reply, mirroring acpRecommender's test seam shape.
function fakeConnect(reply: string): AcpConnectFn {
  return async () => ({
    ctx: { open: async () => ({ setMode: async () => {}, promptText: async () => reply, dispose: () => {} }) },
    close: () => {},
  });
}

describe("rerankCandidates", () => {
  const input = { candidates: [cand("a"), cand("b"), cand("c")], topics: ["x"] };

  it("reorders by the agent's order, rewrites reasons, and keeps only known items", async () => {
    const reply = JSON.stringify({ order: [
      { source: "o/r", name: "c", reason: "best fit" },
      { source: "o/r", name: "a", reason: "ok" },
      { source: "o/r", name: "ghost", reason: "invented" }, // dropped
    ] });
    const out = await rerankCandidates(input, { connectFn: fakeConnect(reply) });
    expect(out.reranked).toBe(true);
    // c, a from the agent; b appended (agent omitted it) so nothing is lost
    expect(out.candidates.map((c) => c.name)).toEqual(["c", "a", "b"]);
    expect(out.candidates[0]!.reason).toBe("best fit");
    expect(out.candidates[2]!.reason).toBe("orig"); // untouched
    expect(out.degraded).toBeUndefined();
  });

  it("degrades to input order when the agent returns junk", async () => {
    const out = await rerankCandidates(input, { connectFn: fakeConnect("not json") });
    expect(out.candidates.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(out.reranked).toBe(false);
    expect(out.degraded?.reason).toMatch(/re-rank/i);
  });

  it("degrades when the agent connection throws", async () => {
    const boom: AcpConnectFn = async () => { throw new Error("no agent"); };
    const out = await rerankCandidates(input, { connectFn: boom });
    expect(out.candidates.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(out.reranked).toBe(false);
  });

  it("is a no-op for 0–1 candidates (no agent call)", async () => {
    let called = false;
    const spy: AcpConnectFn = async () => { called = true; throw new Error("x"); };
    const out = await rerankCandidates({ candidates: [cand("solo")], topics: ["x"] }, { connectFn: spy });
    expect(called).toBe(false);
    expect(out.candidates.map((c) => c.name)).toEqual(["solo"]);
    expect(out.reranked).toBe(false);
  });
});

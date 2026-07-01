// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { rerankCandidates, type DiscoverCandidate, type AcpConnectFn } from "@agentgem/insight";

const cand = (name: string, source = "o/r"): DiscoverCandidate => ({
  name, source, skillId: name, registry: "skills.sh", installs: 1,
  url: `https://skills.sh/${source}/${name}`, reason: "orig", installCmd: `npx skills add ${source}@${name}`,
});

// Fake ACP connect: returns a fixed agent reply, mirroring acpRecommender's test seam shape.
function fakeConnect(reply: string): AcpConnectFn {
  return async () => ({
    ctx: { open: async () => ({ setMode: async () => {}, promptText: async () => reply, dispose: () => {} }) },
    close: () => {},
  });
}

// Fake connect that also captures the prompt the agent was given.
function capturingConnect(reply: string, sink: { prompt?: string }): AcpConnectFn {
  return async () => ({
    ctx: { open: async () => ({ setMode: async () => {}, promptText: async (p: string) => { sink.prompt = p; return reply; }, dispose: () => {} }) },
    close: () => {},
  });
}

// Hermetic description fetch — keeps tests off the network (the real one shells `skills use`).
const noDescribe = async () => new Map<string, string>();

describe("rerankCandidates", () => {
  const input = { candidates: [cand("a"), cand("b"), cand("c")], topics: ["x"] };

  it("reorders by the agent's order, rewrites reasons, and keeps only known items", async () => {
    const reply = JSON.stringify({ order: [
      { source: "o/r", name: "c", reason: "best fit" },
      { source: "o/r", name: "a", reason: "ok" },
      { source: "o/r", name: "ghost", reason: "invented" }, // dropped
    ] });
    const out = await rerankCandidates(input, { connectFn: fakeConnect(reply), describe: noDescribe });
    expect(out.reranked).toBe(true);
    // c, a from the agent; b appended (agent omitted it) so nothing is lost
    expect(out.candidates.map((c) => c.name)).toEqual(["c", "a", "b"]);
    expect(out.candidates[0]!.reason).toBe("best fit");
    expect(out.candidates[2]!.reason).toBe("orig"); // untouched
    expect(out.degraded).toBeUndefined();
  });

  it("degrades to input order when the agent returns junk", async () => {
    const out = await rerankCandidates(input, { connectFn: fakeConnect("not json"), describe: noDescribe });
    expect(out.candidates.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(out.reranked).toBe(false);
    expect(out.degraded?.reason).toMatch(/re-rank/i);
  });

  it("degrades when the agent connection throws", async () => {
    const boom: AcpConnectFn = async () => { throw new Error("no agent"); };
    const out = await rerankCandidates(input, { connectFn: boom, describe: noDescribe });
    expect(out.candidates.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(out.reranked).toBe(false);
  });

  it("is a no-op for 0–1 candidates (no agent call)", async () => {
    let called = false;
    const spy: AcpConnectFn = async () => { called = true; throw new Error("x"); };
    const out = await rerankCandidates({ candidates: [cand("solo")], topics: ["x"] }, { connectFn: spy, describe: noDescribe });
    expect(called).toBe(false);
    expect(out.candidates.map((c) => c.name)).toEqual(["solo"]);
    expect(out.reranked).toBe(false);
  });

  it("threads fetched skill descriptions into the agent prompt", async () => {
    const sink: { prompt?: string } = {};
    const reply = JSON.stringify({ order: [{ source: "o/r", name: "a" }, { source: "o/r", name: "b" }, { source: "o/r", name: "c" }] });
    const describe = async () => new Map([["o/r@a", "Turns rough ideas into designs"]]);
    await rerankCandidates(input, { connectFn: capturingConnect(reply, sink), describe });
    expect(sink.prompt).toContain("description: Turns rough ideas into designs");
    // candidates without a fetched description carry no description line
    expect(sink.prompt).toContain("o/r@b (1 installs)");
  });
});

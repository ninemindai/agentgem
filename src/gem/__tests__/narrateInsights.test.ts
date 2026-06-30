// src/gem/__tests__/narrateInsights.test.ts
import { describe, it, expect } from "vitest";
import { narrateInsights, validateNarrative } from "@agentgem/insight";
import type { SessionFacet, SessionOutcome, AcpConnectFn } from "@agentgem/insight";

function facet(id: string, outcome: SessionOutcome): SessionFacet {
  return {
    sessionId: id, transcript: `${id}.jsonl`, atMs: 0,
    underlying_goal: `goal-${id}`, brief_summary: `summary-${id}`,
    outcome, friction_detail: "", origin: "llm",
  };
}

function fakeConnect(canned: string): AcpConnectFn {
  return async () => ({
    ctx: {
      async open(_cwd: string) {
        let mode = "default";
        return {
          async setMode(m: string) { mode = m; },
          async promptText(_t: string) {
            if (mode !== "plan") throw new Error(`expected plan mode, got ${mode}`);
            return canned;
          },
          dispose() {},
        };
      },
    },
    close() {},
  });
}

const FACETS = [facet("a", "mostly_achieved"), facet("b", "not_achieved")];

describe("validateNarrative", () => {
  it("extracts the narrative string", () => {
    expect(validateNarrative(JSON.stringify({ narrative: "You ship end-to-end." }), "FB")).toBe("You ship end-to-end.");
  });
  it("falls back on non-JSON", () => {
    expect(validateNarrative("not json", "FB")).toBe("FB");
  });
  it("falls back when narrative is missing or not a string", () => {
    expect(validateNarrative(JSON.stringify({ narrative: 42 }), "FB")).toBe("FB");
    expect(validateNarrative(JSON.stringify({ nope: "x" }), "FB")).toBe("FB");
  });
});

describe("narrateInsights", () => {
  it("produces the agent narrative (degraded:false)", async () => {
    const { narrative, degraded } = await narrateInsights(FACETS, "FB", { connectFn: fakeConnect(JSON.stringify({ narrative: "You operate as a hands-on founder." })) });
    expect(degraded).toBe(false);
    expect(narrative).toBe("You operate as a hands-on founder.");
  });

  it("returns the fallback without calling the agent when there are no facets", async () => {
    const { narrative, degraded } = await narrateInsights([], "FB", {
      connectFn: async () => { throw new Error("should not be called"); },
    });
    expect(narrative).toBe("FB");
    expect(degraded).toBe(false);
  });

  it("degrades to the fallback on agent error", async () => {
    const { narrative, degraded } = await narrateInsights(FACETS, "FB", {
      connectFn: async () => { throw new Error("no binary"); },
    });
    expect(degraded).toBe(true);
    expect(narrative).toBe("FB");
  });

  it("falls back to the fallback (degraded:false) on junk output", async () => {
    const { narrative, degraded } = await narrateInsights(FACETS, "FB", { connectFn: fakeConnect("not json") });
    expect(degraded).toBe(false);
    expect(narrative).toBe("FB");
  });
});

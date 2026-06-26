// src/gem/__tests__/distill.test.ts
import { describe, it, expect } from "vitest";
import { distillCandidates } from "../distill.js";
import type { WorkflowSignal, ProcedureStep, SessionSequence } from "../workflowScan.js";

function step(tool: string, verb: string): ProcedureStep {
  return { tool, verb, arg: "" };
}
const SPINE = [
  step("Bash", "Bash:git checkout"),
  step("Edit", "Edit"),
  step("Bash", "Bash:npx vitest"),
  step("Bash", "Bash:git commit"),
];
function sessionSeq(steps: ProcedureStep[]): SessionSequence {
  return { steps };
}

function signalWith(
  sessions: SessionSequence[],
  procedures: WorkflowSignal["procedures"],
): WorkflowSignal {
  return {
    root: "/r", flavor: "claude",
    sessions: { scanned: sessions.length, firstMs: 0, lastMs: 0, spanDays: 0 },
    artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
    sequences: { root: "/r", sessions },
    procedures,
  };
}

describe("distillCandidates — Phase-0 gate", () => {
  it("returns [] when the signal has no procedures", () => {
    const sig: WorkflowSignal = {
      root: "/r", flavor: "claude",
      sessions: { scanned: 0, firstMs: 0, lastMs: 0, spanDays: 0 },
      artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
    };
    expect(distillCandidates(sig)).toEqual([]);
  });

  it("keeps a recurring, long-enough procedure and attaches its sample run", () => {
    const sessions = [sessionSeq(SPINE), sessionSeq(SPINE)];
    const verbs = SPINE.map((s) => s.verb);
    const sig = signalWith(sessions, [{ key: verbs.join(" > "), verbs, sessions: 2, sampleSessionIdx: 1 }]);
    const out = distillCandidates(sig);
    expect(out).toHaveLength(1);
    expect(out[0].sessions).toBe(2);
    expect(out[0].sample).toBe(sessions[1]);
  });

  it("drops a one-off procedure (sessions < MIN_RECURRENCE)", () => {
    const verbs = SPINE.map((s) => s.verb);
    const sig = signalWith([sessionSeq(SPINE)], [{ key: verbs.join(" > "), verbs, sessions: 1, sampleSessionIdx: 0 }]);
    expect(distillCandidates(sig)).toEqual([]);
  });

  it("drops a too-short procedure (verbs < MIN_STEPS)", () => {
    const short = [step("Bash", "Bash:ls"), step("Bash", "Bash:cat")];
    const verbs = short.map((s) => s.verb);
    const sig = signalWith([sessionSeq(short), sessionSeq(short)], [{ key: verbs.join(" > "), verbs, sessions: 2, sampleSessionIdx: 0 }]);
    expect(distillCandidates(sig)).toEqual([]);
  });
});

import { validateDistilled } from "../distill.js";
import type { ProcedureCandidate } from "../distill.js";

const INV = {
  project: {
    root: "/r", name: "app",
    skills: [{ type: "skill" as const, name: "existing-skill", source: "project" as const, content: "x" }],
    mcpServers: [], instructions: [], hooks: [],
  },
};
const CANDIDATES: ProcedureCandidate[] = [{
  key: "k", verbs: ["Bash:git checkout", "Edit", "Bash:npx vitest", "Bash:git commit"], sessions: 3, sampleSessionIdx: 0,
  sample: { steps: [
    { tool: "Bash", verb: "Bash:git checkout", arg: "git checkout -b feat" },
    { tool: "Edit", verb: "Edit", arg: "/r/a.ts" },
    { tool: "Bash", verb: "Bash:npx vitest", arg: "npx vitest run" },
  ] },
}];
const good = {
  name: "tdd-feature-loop", description: "Run the TDD loop for a feature.",
  triggers: ["add a feature with tests"], tools: ["Bash", "Edit"], mutating: false,
  body: "## Contract\n...\n## Phases\n...\n## Output Format\n...", confidence: "high",
};

describe("validateDistilled", () => {
  it("accepts a well-formed skill, stamps draft, forces mutating for Bash/Edit", () => {
    const out = validateDistilled(JSON.stringify({ distilled: [good] }), INV, CANDIDATES);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("draft");
    expect(out[0].mutating).toBe(true); // Bash/Edit in evidence → forced
    expect(out[0].evidence.sessions).toBe(3);
  });

  it("returns [] on non-JSON", () => {
    expect(validateDistilled("totally not json", INV, CANDIDATES)).toEqual([]);
  });

  it("drops a non-kebab name", () => {
    const out = validateDistilled(JSON.stringify({ distilled: [{ ...good, name: "Not Kebab!" }] }), INV, CANDIDATES);
    expect(out).toEqual([]);
  });

  it("drops a skill with empty triggers", () => {
    const out = validateDistilled(JSON.stringify({ distilled: [{ ...good, triggers: [] }] }), INV, CANDIDATES);
    expect(out).toEqual([]);
  });

  it("drops a slug colliding with an installed skill", () => {
    const out = validateDistilled(JSON.stringify({ distilled: [{ ...good, name: "existing-skill" }] }), INV, CANDIDATES);
    expect(out).toEqual([]);
  });

  it("drops a skill claiming a tool absent from the evidence", () => {
    const out = validateDistilled(JSON.stringify({ distilled: [{ ...good, tools: ["Bash", "WebFetch"] }] }), INV, CANDIDATES);
    expect(out).toEqual([]);
  });
});

import { distillWorkflow } from "../distill.js";
import type { AcpConnectFn } from "../acpRecommender.js";

function fakeConnect(canned: string | (() => Promise<string>)): AcpConnectFn {
  return async () => ({
    ctx: {
      async open(_cwd: string) {
        let mode = "default";
        return {
          async setMode(m: string) { mode = m; },
          async promptText(_t: string) {
            if (mode !== "plan") throw new Error(`expected plan mode, got ${mode}`);
            return typeof canned === "function" ? canned() : canned;
          },
          dispose() {},
        };
      },
    },
    close() {},
  });
}

const SIG: WorkflowSignal = {
  root: "/r", flavor: "claude",
  sessions: { scanned: 3, firstMs: 0, lastMs: 0, spanDays: 0 },
  artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
  sequences: { root: "/r", sessions: [CANDIDATES[0].sample] },
  procedures: [{ key: CANDIDATES[0].key, verbs: CANDIDATES[0].verbs, sessions: 3, sampleSessionIdx: 0 }],
};

describe("distillWorkflow", () => {
  it("distills a draft skill from a qualifying procedure", async () => {
    const canned = JSON.stringify({ distilled: [good] });
    const { distilled, degraded } = await distillWorkflow(SIG, INV, { connectFn: fakeConnect(canned) });
    expect(degraded).toBe(false);
    expect(distilled).toHaveLength(1);
    expect(distilled[0].name).toBe("tdd-feature-loop");
  });

  it("short-circuits with no candidates (agent never invoked)", async () => {
    const empty: WorkflowSignal = { ...SIG, procedures: [], sequences: { root: "/r", sessions: [] } };
    const { distilled, degraded } = await distillWorkflow(empty, INV, {
      connectFn: async () => { throw new Error("should not be called"); },
    });
    expect(distilled).toEqual([]);
    expect(degraded).toBe(false);
  });

  it("degrades to empty (never throws) on agent error", async () => {
    const { distilled, degraded } = await distillWorkflow(SIG, INV, {
      connectFn: async () => { throw new Error("no binary"); },
    });
    expect(distilled).toEqual([]);
    expect(degraded).toBe(true);
  });
});

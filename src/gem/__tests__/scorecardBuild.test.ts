// src/gem/__tests__/scorecardBuild.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolve } from "node:path";
import { GemController } from "../../gem.controller.js";
import { defaultScorecardDeps } from "../scorecard.js";
import type { ProcedureCandidate } from "../distillTypes.js";
import type { WorkflowSignal } from "../workflowScan.js";

const ROOT = resolve(process.cwd());

function mkCandidate(key: string, nameSlug: string): ProcedureCandidate {
  return {
    key,
    verbs: ["Edit", "Bash:git commit"],
    sessions: 3,
    sampleSessionIdx: 0,
    sessionIdxs: [0, 1, 2],
    sample: {
      steps: [
        { tool: "Edit", verb: "Edit", arg: "src/foo.ts", msgIndex: 0 },
        { tool: "Bash", verb: "Bash:git commit", arg: "git commit -m fix", msgIndex: 2 },
      ],
      sessionId: "synthetic-session",
      transcript: "synthetic.jsonl",
      atMs: 1_700_000_000_000,
    },
    provenance: { occurrences: [] },
    skeleton: {
      name: nameSlug,
      description: "Synthetic test skill",
      triggers: ["commit changes to the repo"],
      tools: ["Edit", "Bash"],
      mutating: true,
      body: "Edit a file then run git commit.",
      evidence: {
        sessions: 3,
        exampleSequence: ["Edit", "Bash:git commit"],
        root: ROOT,
        provenance: { occurrences: [] },
      },
      status: "draft",
      confidence: "high",
      origin: "heuristic",
    },
    priorConfidence: "high",
  };
}

const MINIMAL_SIGNAL: WorkflowSignal = {
  root: ROOT,
  flavor: "claude",
  sessions: { scanned: 3, firstMs: 0, lastMs: 1_700_000_000_000, spanDays: 7 },
  artifacts: [],
  models: [],
  unresolved: [],
  coOccurrence: [],
  shapes: [],
  notes: [],
};

describe("POST /api/scorecard/build handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a Gem from selected workflow keys", async () => {
    const c1 = mkCandidate("k1", "synthetic-skill-one");
    const c2 = mkCandidate("k2", "synthetic-skill-two");
    vi.spyOn(defaultScorecardDeps, "loadProject").mockReturnValue({
      signal: MINIMAL_SIGNAL,
      candidates: [c1, c2],
      reflections: [],
    });

    const ctrl = new GemController();
    const gem = await ctrl.scorecardBuild({
      body: {
        name: "test-gem",
        selections: [{ root: ROOT, keys: ["k1", "k2"] }],
      },
    });

    expect(typeof gem.name).toBe("string");
    expect(gem.name).toBe("test-gem");
    expect(Array.isArray(gem.artifacts)).toBe(true);
    expect(gem.artifacts.length).toBe(2);
    // No dollar / latentValue leak
    expect(JSON.stringify(gem)).not.toMatch(/\$|latentValue|dollars/);
  });

  it("throws 400 for unknown workflow keys", async () => {
    const ctrl = new GemController();
    await expect(
      ctrl.scorecardBuild({
        body: {
          selections: [{ root: process.cwd(), keys: ["__nope__"] }],
        },
      }),
    ).rejects.toThrow();
  });
});

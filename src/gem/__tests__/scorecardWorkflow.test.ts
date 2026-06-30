// src/gem/__tests__/scorecardWorkflow.test.ts
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { GemController } from "../../gem.controller.js";
import { defaultScorecardDeps } from "../scorecard.js";
import type { ProcedureCandidate } from "@agentgem/insight";
import type { WorkflowSignal } from "@agentgem/insight";
import { useHermeticHome } from "../../__tests__/support/hermeticHome.js";

let restoreHome: () => void;
beforeAll(() => { restoreHome = useHermeticHome(); });
afterAll(() => restoreHome());

const ROOT = resolve(process.cwd());

function mkCandidate(key: string, nameSlug: string): ProcedureCandidate {
  return {
    key,
    verbs: ["Edit", "Bash:git commit"],
    sessions: 5,
    sampleSessionIdx: 0,
    sessionIdxs: [0, 1, 2, 3, 4],
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
      description: "Synthetic workflow detail",
      triggers: ["commit changes to the repo"],
      tools: ["Edit", "Bash"],
      mutating: true,
      body: "Edit a file then run git commit.",
      evidence: {
        sessions: 5,
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
  sessions: { scanned: 5, firstMs: 0, lastMs: 1_700_000_000_000, spanDays: 7 },
  artifacts: [],
  models: [],
  unresolved: [],
  coOccurrence: [],
  shapes: [],
  notes: [],
};

describe("GET /api/scorecard/workflow handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns detail for a known workflow key", async () => {
    const c = mkCandidate("k1", "synthetic-skill-one");
    vi.spyOn(defaultScorecardDeps, "loadProject").mockReturnValue({
      signal: MINIMAL_SIGNAL,
      candidates: [c],
      reflections: [],
    });

    const ctrl = new GemController();
    const detail = await ctrl.scorecardWorkflow({ query: { root: ROOT, key: "k1" } });

    expect(detail.key).toBe("k1");
    expect(detail.name).toBe("synthetic-skill-one");
    expect(detail.description).toBe("Synthetic workflow detail");
    expect(detail.triggers).toEqual(["commit changes to the repo"]);
    expect(detail.tools).toEqual(["Edit", "Bash"]);
    expect(detail.mutating).toBe(true);
    expect(detail.steps).toEqual(["Edit", "Bash:git commit"]);
    expect(detail.sessions).toBe(5);
    expect(detail.confidence).toBe("high");
    expect(typeof detail.portable).toBe("boolean");
  });

  it("sanitizes URL in description before returning", async () => {
    const c = mkCandidate("k-url", "url-skill");
    c.skeleton.description = "See https://internal.example.com/docs for details";
    vi.spyOn(defaultScorecardDeps, "loadProject").mockReturnValue({
      signal: MINIMAL_SIGNAL,
      candidates: [c],
      reflections: [],
    });

    const ctrl = new GemController();
    const detail = await ctrl.scorecardWorkflow({ query: { root: ROOT, key: "k-url" } });

    expect(detail.description).not.toContain("http");
    expect(detail.description).toContain("for details");
  });

  it("throws InvalidInputError for an unknown workflow key", async () => {
    const c = mkCandidate("k1", "synthetic-skill-one");
    vi.spyOn(defaultScorecardDeps, "loadProject").mockReturnValue({
      signal: MINIMAL_SIGNAL,
      candidates: [c],
      reflections: [],
    });

    const ctrl = new GemController();
    await expect(
      ctrl.scorecardWorkflow({ query: { root: ROOT, key: "__nope__" } }),
    ).rejects.toThrow();
  });
});

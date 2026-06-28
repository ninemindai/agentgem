// src/gem/__tests__/extract.test.ts
import { describe, it, expect } from "vitest";
import { buildProvenance, heuristicSkeleton, scoreCandidate, extractCandidates } from "../extract.js";
import { validateDistilled } from "../distill.js";
import type { SessionSequence } from "../workflowScan.js";
import type { GatedCandidate } from "../distillTypes.js";

// ── Task 3: buildProvenance ──────────────────────────────────────────────────

function session(verbs: string[], base: { sessionId: string; transcript: string; atMs: number }): SessionSequence {
  return { ...base, steps: verbs.map((verb, i) => ({ tool: verb.split(":")[0], verb, arg: "", msgIndex: i * 2 })) };
}

describe("buildProvenance", () => {
  it("maps a verb-run to the matching step msgIndices in each exercising session", () => {
    const verbs = ["Edit", "Bash:git commit"];
    const s0 = session(["Read", "Edit", "Bash:git commit"], { sessionId: "a", transcript: "a.jsonl", atMs: 10 });
    const s1 = session(["Edit", "Bash:git commit", "Bash:git push"], { sessionId: "b", transcript: "b.jsonl", atMs: 20 });
    const prov = buildProvenance(verbs, [s0, s1], [0, 1]);
    expect(prov.occurrences).toHaveLength(2);
    expect(prov.occurrences[0]).toMatchObject({ sessionId: "a", transcript: "a.jsonl", atMs: 10 });
    // s0 spine = [Edit(2), Bash:git commit(4)] (Read at msgIndex 0 is nav-dropped)
    expect(prov.occurrences[0].messageIndices).toEqual([2, 4]);
    expect(prov.occurrences[1].messageIndices).toEqual([0, 2]);
  });

  it("skips a session where the run does not occur (no crash)", () => {
    const s0 = session(["Write"], { sessionId: "a", transcript: "a.jsonl", atMs: 1 });
    const prov = buildProvenance(["Edit", "Bash:git commit"], [s0], [0]);
    expect(prov.occurrences).toEqual([]);
  });
});

// ── Task 4: heuristicSkeleton + scoreCandidate + junk filter ─────────────────

const inv = { project: { root: "/r", name: "r", skills: [], mcpServers: [], hooks: [], instructions: [] } } as any;

function gated(verbs: string[], opts: Partial<GatedCandidate> = {}): GatedCandidate {
  const steps = verbs.map((verb, i) => ({ tool: verb.split(":")[0], verb, arg: "", msgIndex: i }));
  return {
    key: verbs.join(" > "), verbs, sessions: 2, sampleSessionIdx: 0, sessionIdxs: [0],
    sample: { steps, sessionId: "s", transcript: "s.jsonl", atMs: 0, missionHint: { task: "Ship the auth migration", outcome: "done" } },
    ...opts,
  };
}

describe("heuristicSkeleton", () => {
  it("produces a draft that survives validateDistilled and is grounded", () => {
    const c = gated(["Edit", "Bash:git commit"]);
    const prov = { occurrences: [] };
    const sk = heuristicSkeleton(c, prov, inv);
    expect(sk.origin).toBe("heuristic");
    expect(sk.confidence).toBe("low");
    expect(sk.triggers.length).toBeGreaterThan(0);
    expect(sk.tools).toEqual(["Edit", "Bash"]);
    expect(sk.mutating).toBe(true);                 // Edit/Bash present
    // Round-trip: a skeleton re-validated as if it were agent output must survive.
    const fake = { distilled: [{ name: sk.name, description: sk.description, triggers: sk.triggers, tools: sk.tools, mutating: sk.mutating, body: sk.body, confidence: "low" }] };
    const c2 = { ...c, provenance: prov, skeleton: sk, priorConfidence: "low" as const };
    expect(validateDistilled(fake, inv, [c2])).toHaveLength(1);
  });

  it("dedupes its slug against an installed skill", () => {
    const c = gated(["Edit", "Bash:git commit"]);
    const sk = heuristicSkeleton(c, { occurrences: [] }, inv);
    const invWith = { project: { ...inv.project, skills: [{ name: sk.name }] } } as any;
    const sk2 = heuristicSkeleton(c, { occurrences: [] }, invWith);
    expect(sk2.name).not.toBe(sk.name);
  });
});

import { extractReflections } from "../extract.js";
import { writeReflections } from "../reflectionStore.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function reflSignal(verbs: string[], sessions = 2): any {
  const steps = verbs.map((verb, i) => ({ tool: verb.split(":")[0], verb, arg: "", msgIndex: i }));
  return {
    root: "/r", flavor: "claude", sessions: { scanned: sessions, firstMs: 0, lastMs: 0, spanDays: 0 },
    artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
    sequences: { root: "/r", sessions: Array.from({ length: sessions }, (_, i) => ({ steps, sessionId: `s${i}`, transcript: `s${i}.jsonl`, atMs: 0 })) },
    procedures: [{ key: verbs.join(" > "), verbs, sessions, sampleSessionIdx: 0, sessionIdxs: Array.from({ length: sessions }, (_, i) => i) }],
  };
}

describe("extractReflections", () => {
  it("flags repeated edits with no terminal commit/push as unresolved-task", () => {
    const refl = extractReflections(reflSignal(["Edit", "Write", "Bash:npm run build"]));
    expect(refl.some((r) => r.kind === "unresolved-task")).toBe(true);
    expect(refl[0].provenance.occurrences.length).toBeGreaterThan(0);
  });
  it("flags a highly recurrent procedure as recurring-pattern", () => {
    const refl = extractReflections(reflSignal(["Edit", "Bash:npx vitest", "Bash:git commit"], 4));
    expect(refl.some((r) => r.kind === "recurring-pattern")).toBe(true);
  });
});

describe("writeReflections", () => {
  it("writes a sidecar JSON and returns its path", () => {
    const base = mkdtempSync(join(tmpdir(), "refl-"));
    const refl = extractReflections(reflSignal(["Edit", "Write", "Bash:npm run build"]));
    const path = writeReflections(refl, "/some/root", base);
    expect(path).toBeTruthy();
    const parsed = JSON.parse(readFileSync(path!, "utf8"));
    expect(parsed.root).toBe("/some/root");
    expect(Array.isArray(parsed.reflections)).toBe(true);
  });
  it("returns null when there is nothing to persist", () => {
    expect(writeReflections([], "/r", mkdtempSync(join(tmpdir(), "refl-")))).toBeNull();
  });
});

describe("scoreCandidate + extractCandidates junk filter", () => {
  it("scores a strong-mission, high-recurrence candidate high", () => {
    expect(scoreCandidate(gated(["Edit", "Bash:git commit"], { sessions: 5 }), 2)).toBe("high");
  });
  it("drops an empty-mission candidate at minimum recurrence", () => {
    const sig = {
      root: "/r", flavor: "claude", sessions: { scanned: 1, firstMs: 0, lastMs: 0, spanDays: 0 },
      artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
      sequences: { root: "/r", sessions: [{ steps: [{ tool: "Edit", verb: "Edit", arg: "", msgIndex: 0 }, { tool: "Bash", verb: "Bash:x", arg: "", msgIndex: 1 }, { tool: "Bash", verb: "Bash:y", arg: "", msgIndex: 2 }], sessionId: "s", transcript: "s.jsonl", atMs: 0 }] },
      procedures: [{ key: "k", verbs: ["Edit", "Bash:x", "Bash:y"], sessions: 2, sampleSessionIdx: 0, sessionIdxs: [0] }],
    } as any;
    // No missionHint on the only session → empty-mission + min recurrence → dropped.
    expect(extractCandidates(sig, inv).candidates).toHaveLength(0);
  });
});

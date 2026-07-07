// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/contextHygieneRubric.test.ts
import { describe, it, expect } from "vitest";
import { builtinRubrics, scopeAllowed, HYGIENE_FACTOR_IDS } from "@agentgem/insight";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanWorkflow, evaluateRubric } from "@agentgem/insight";

const emptyInv = { project: { root: "/r", skills: [], mcpServers: [], hooks: [], instructions: [] }, global: { skills: [], mcpServers: [], hooks: [] } } as any;

// A bloated session: pinned at the 1M cap across many turns + sprawl across clusters.
function writeBloated(dir: string, name: string): string {
  const lines: string[] = [JSON.stringify({ sessionId: name, type: "user", message: { role: "user", content: "go" } })];
  for (let i = 0; i < 30; i++) lines.push(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant", model: "claude-opus-4-8[1m]",
      content: [{ type: "tool_use", name: "Read", input: { file_path: `packages/p${i % 8}/f.ts` } }],
      usage: { input_tokens: 100, cache_read_input_tokens: 990_000, cache_creation_input_tokens: 5000, output_tokens: 10 },
    },
  }));
  const p = join(dir, `${name}.jsonl`); writeFileSync(p, lines.join("\n")); return p;
}
// A session that trips retry-storm: the SAME Bash command run back-to-back.
// retry-storm is a factor of the legacy "hygiene" rubric but NOT one of the
// five context-hygiene factors (see HYGIENE_FACTOR_IDS), so it is exactly the
// case that must leave perSession `hygiene` undefined while still producing
// a non-empty perSession entry.
function writeRetryStorm(dir: string, name: string): string {
  const lines: string[] = [JSON.stringify({ sessionId: name, type: "user", message: { role: "user", content: "go" } })];
  for (let i = 0; i < 4; i++) lines.push(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", model: "claude-opus-4-8[1m]",
      content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }],
      usage: { input_tokens: 100, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500, output_tokens: 10 } },
  }));
  const p = join(dir, `${name}.jsonl`); writeFileSync(p, lines.join("\n")); return p;
}
// A clean session: short, tiny window, one cluster.
function writeClean(dir: string, name: string): string {
  const lines = [
    JSON.stringify({ sessionId: name, type: "user", message: { role: "user", content: "go" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-4-8[1m]",
      content: [{ type: "tool_use", name: "Read", input: { file_path: "packages/a/f.ts" } }],
      usage: { input_tokens: 100, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500, output_tokens: 10 } } }),
  ];
  const p = join(dir, `${name}.jsonl`); writeFileSync(p, lines.join("\n")); return p;
}

describe("context-hygiene built-in rubric", () => {
  const rubric = () => builtinRubrics().find((r) => r.id === "context-hygiene")!;

  it("exists, is distinct from the 'hygiene' rubric, and references exactly the five hygiene factors", () => {
    const r = rubric();
    expect(r).toBeDefined();
    expect(r.id).not.toBe("hygiene");
    const factorIds = r.factors.map((f) => f.factor).sort();
    expect(factorIds).toEqual([...HYGIENE_FACTOR_IDS].sort());
  });

  it("is runnable at scope 'all' and 'project' (session-granular, all cheap)", () => {
    const r = rubric();
    expect(scopeAllowed(r, "all")).toBe(true);
    expect(scopeAllowed(r, "project")).toBe(true);
    expect(r.naturalScope).toBe("all");
  });

  it("leaves the pre-existing 'hygiene' rubric untouched (process-quality factors)", () => {
    const legacy = builtinRubrics().find((r) => r.id === "hygiene")!;
    expect(legacy.factors.map((f) => f.factor)).toContain("retry-storm");
    expect(legacy.factors.map((f) => f.factor)).not.toContain("context-pinned");
  });
});

describe("evaluateRubric — per-session hygiene verdict", () => {
  const ctxRubric = () => builtinRubrics().find((r) => r.id === "context-hygiene")!;

  it("attaches a hygiene verdict to each tripped perSession entry; clean session is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lb-"));
    const signal = scanWorkflow([writeBloated(dir, "bad1"), writeClean(dir, "good1")], emptyInv, { retainSequences: true });
    const report = await evaluateRubric(signal, ctxRubric(), { scope: { kind: "all" } } as any);
    const ids = (report.perSession ?? []).map((s) => s.sessionId);
    expect(ids).toContain("bad1");
    expect(ids).not.toContain("good1");                    // clean → no findings → not enumerated
    const bad = report.perSession!.find((s) => s.sessionId === "bad1")!;
    expect(bad.hygiene).toBeDefined();
    expect(bad.hygiene!.verdict).toBe("bloated");
  });

  it("leaves perSession hygiene undefined for a non-hygiene rubric (with real findings)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lb2-"));
    const signal = scanWorkflow([writeRetryStorm(dir, "retry1")], emptyInv, { retainSequences: true });
    const legacy = builtinRubrics().find((r) => r.id === "hygiene")!;
    const report = await evaluateRubric(signal, legacy, { scope: { kind: "all" } } as any);
    expect(report.perSession && report.perSession.length).toBeGreaterThan(0);   // the fixture MUST trip a factor
    for (const s of report.perSession!) expect(s.hygiene).toBeUndefined();
  });
});

// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { previewGuardrails, applyGuardrails, resolveTarget } from "@agentgem/model";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = () => mkdtempSync(join(tmpdir(), "mr-"));
const MARK_OPEN = "<!-- agentgem:learnings -->";

describe("managed region", () => {
  it("appends a fenced block, preserving hand-written content verbatim", () => {
    const dir = tmp(); const f = join(dir, "CLAUDE.md");
    writeFileSync(f, "# My rules\n\nhand written\n", "utf8");
    const { next, hash } = previewGuardrails(f, ["- Do not touch prod."]);
    const res = applyGuardrails(f, ["- Do not touch prod."], hash);
    expect(res.ok).toBe(true);
    const out = readFileSync(f, "utf8");
    expect(out).toContain("# My rules");
    expect(out).toContain("hand written");
    expect(out).toContain(MARK_OPEN);
    expect(out).toContain("- Do not touch prod.");
    expect(out).toBe(next);
  });

  it("is idempotent — re-applying the same block updates in place, no duplicate", () => {
    const dir = tmp(); const f = join(dir, "CLAUDE.md");
    writeFileSync(f, "base\n", "utf8");
    let h = previewGuardrails(f, ["- rule A"]).hash;
    applyGuardrails(f, ["- rule A"], h);
    h = previewGuardrails(f, ["- rule A"]).hash;
    applyGuardrails(f, ["- rule A"], h);
    const out = readFileSync(f, "utf8");
    expect(out.match(new RegExp(MARK_OPEN, "g"))!.length).toBe(1);
    expect(out.match(/- rule A/g)!.length).toBe(1);
  });

  it("aborts on stale hash instead of clobbering", () => {
    const dir = tmp(); const f = join(dir, "CLAUDE.md");
    writeFileSync(f, "base\n", "utf8");
    const { hash } = previewGuardrails(f, ["- x"]);
    writeFileSync(f, "base CHANGED BY HUMAN\n", "utf8");     // drift after preview
    const res = applyGuardrails(f, ["- x"], hash);
    expect(res.ok).toBe(false);
    expect(readFileSync(f, "utf8")).toContain("CHANGED BY HUMAN");   // untouched
  });

  it("resolveTarget detects an existing file and flags ambiguity", () => {
    const dir = tmp();
    writeFileSync(join(dir, "CLAUDE.md"), "x", "utf8");
    expect(resolveTarget(dir).target).toBe("claude");
    writeFileSync(join(dir, "AGENTS.md"), "y", "utf8");
    expect(resolveTarget(dir).ambiguous).toBe(true);
  });
});

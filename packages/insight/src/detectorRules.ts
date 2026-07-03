// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/detectorRules.ts
//
// Tier-2 pluggability for the detector layer: user-defined criteria as DATA.
// JSON files in ~/.agentgem/detectors/ each hold one rule (or an array), which
// compiles into a DetectorSpec matching a verb sequence against session steps.
// No code execution — a rule is declarative, so there is nothing to sandbox,
// and the same format is the future distributable unit for detector-pack Gems.
// Never throws: missing dir, bad JSON, invalid rules, and id collisions all
// degrade to "rule skipped" (console.error), mirroring the analysis-path
// contract in judgeSession.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { DetectorFinding, DetectorSeverity, DetectorSpec } from "./detectors.js";
import { DETECTORS } from "./detectors.js";

export interface DetectorRule {
  id: string;                 // kebab-case slug, unique across built-ins and rules
  title: string;
  advice: string;
  severity?: DetectorSeverity; // default "info"
  pattern: string[];           // verb sequence, matched exactly and contiguously
  minRepeats?: number;         // non-overlapping matches per session to fire (default 1)
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateRule(raw: unknown): DetectorRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) return null;
  if (typeof r.title !== "string" || !r.title.trim()) return null;
  if (typeof r.advice !== "string" || !r.advice.trim()) return null;
  if (!Array.isArray(r.pattern) || r.pattern.length === 0
    || !r.pattern.every((p) => typeof p === "string" && p.length > 0)) return null;
  if (r.severity !== undefined && r.severity !== "info" && r.severity !== "warn") return null;
  if (r.minRepeats !== undefined
    && (typeof r.minRepeats !== "number" || !Number.isInteger(r.minRepeats) || r.minRepeats < 1)) return null;
  return {
    id: r.id, title: r.title.trim(), advice: r.advice.trim(),
    severity: r.severity as DetectorSeverity | undefined,
    pattern: r.pattern as string[],
    minRepeats: r.minRepeats as number | undefined,
  };
}

/** Compile one validated rule into a DetectorSpec. One finding max per session. */
export function compileRule(rule: DetectorRule): DetectorSpec {
  const severity: DetectorSeverity = rule.severity ?? "info";
  return {
    id: rule.id, title: rule.title, advice: rule.advice, cost: "cheap", severity,
    detect(session) {
      if (rule.pattern.length === 0) return [];   // hand-built rule bypassing validateRule — never fires, never hangs
      const verbs = session.steps.map((s) => s.verb);
      const hits: number[][] = [];
      let i = 0;
      while (i <= verbs.length - rule.pattern.length) {
        let ok = true;
        for (let k = 0; k < rule.pattern.length; k++) {
          if (verbs[i + k] !== rule.pattern[k]) { ok = false; break; }
        }
        if (ok) {
          hits.push(session.steps.slice(i, i + rule.pattern.length).map((s) => s.msgIndex));
          i += rule.pattern.length;   // non-overlapping
        } else i++;
      }
      if (hits.length < (rule.minRepeats ?? 1)) return [];
      const finding: DetectorFinding = {
        detectorId: rule.id, sessionId: session.sessionId, transcript: session.transcript,
        atMs: session.atMs, severity,
        detail: `pattern [${rule.pattern.join(" > ")}] matched ${hits.length}x`,
        evidence: { msgIndices: hits.flat() },
      };
      return [finding];
    },
  };
}

/** Default rules dir (~/.agentgem/detectors), honoring AGENTGEM_HOME via agentgemHome(). */
export function defaultDetectorRulesDir(): string {
  return join(agentgemHome(), ".agentgem", "detectors");
}

/**
 * Load every *.json rule file from the detectors dir (default
 * ~/.agentgem/detectors, honoring AGENTGEM_HOME via agentgemHome()). Files are
 * read in sorted order; each may hold one rule object or an array. Invalid
 * entries and ids colliding with built-ins or earlier rules are skipped.
 */
export function loadRuleDetectors(dir = defaultDetectorRulesDir()): DetectorSpec[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); }
  catch { return []; }   // no dir = no rules — the common case
  const out: DetectorSpec[] = [];
  const seen = new Set(DETECTORS.map((d) => d.id));
  for (const f of files) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      for (const entry of Array.isArray(raw) ? raw : [raw]) {
        const rule = validateRule(entry);
        if (!rule || seen.has(rule.id)) continue;
        seen.add(rule.id);
        out.push(compileRule(rule));
      }
    } catch (err) {
      console.error(`detector rules: skipped ${f}:`, (err as Error).message);
    }
  }
  return out;
}

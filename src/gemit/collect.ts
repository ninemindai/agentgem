// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit/collect.ts
//
// Headless session collection for `agentgem gemit`: enumerate the last 30 days
// of sessions and score the most recent SAMPLE_CAP of them, reusing the same
// in-process chain the server routes and the warm daemon use — scanSessionsCached
// + summarizeSession from @agentgem/insight, and resolveClaudeSession +
// hygieneReportForFile (the daemon's cheap hygiene path, which skips the
// per-session project-inventory walk sessionHygiene would do). No server, no DB.
import {
  resolveClaudeSession, scanSessionsCached, summarizeSession,
  type SessionStat, type SessionSummary,
} from "@agentgem/insight";
import { hygieneReportForFile } from "@agentgem/app/sessionHygieneCore";
import {
  MIN_MSGS, SAMPLE_CAP, WINDOW_DAYS,
  type GemitScoredInput, type GemitSessionInput,
} from "./score.js";

export interface HygieneResult {
  score: number;
  verdict: "bounded" | "mixed" | "bloated";
  findings: Array<{ id: string; title: string; count: number }>;
}

export interface CollectDeps {
  scan?: (dirs?: { claudeDir?: string }) => Promise<SessionStat[]>;
  summarize?: (id: string, agent: string, dirs?: { claudeDir?: string }) => Promise<SessionSummary | null>;
  hygieneFor?: (id: string, claudeDir?: string) => Promise<HygieneResult | null>;
}

async function defaultHygieneFor(id: string, claudeDir?: string): Promise<HygieneResult | null> {
  try {
    const found = await resolveClaudeSession(id, claudeDir ? { claudeDir } : undefined);
    if (!found) return null;
    const report = hygieneReportForFile(found.path);
    return {
      score: report.hygiene.score,
      verdict: report.hygiene.verdict,
      findings: report.factors.map((f) => ({ id: f.id, title: f.title, count: f.count })),
    };
  } catch {
    return null;
  }
}

function toInput(s: SessionStat): GemitSessionInput {
  return {
    sessionId: s.sessionId,
    agent: s.agent,
    endMs: s.endMs,
    msgs: s.msgs,
    tokensOut: s.tokensOut,
    skillNames: Object.keys(s.skills ?? {}),
    subagentNames: Object.keys(s.subagents ?? {}),
    skillCounts: s.skills,
    subagentCounts: s.subagents,
    // Basename identity (matches the Observe UI's project notion): full cwd would
    // count every worktree of one repo as a separate project.
    projectKey: s.project ?? s.cwd ?? null,
  };
}

// The window totals alone, without the slow part. collectGemitInputs spends nearly all its
// time in the per-session summarize/hygiene loop below; enumerating and filtering only
// needs the scan, which this shares via the same cache. Splitting it out lets a UI say
// "scoring 150 of 5,870" instead of showing an unlabelled spinner for ~30s.
//
// Measured on a 5,870-session window: ~11s COLD (the scan cache has to be built) but
// ~0.07-0.2s once warm. So a caller must still handle the cold case gracefully — this is
// "much faster than scoring", not "instant".
export async function countGemitWindow(
  dir: string | undefined,
  nowMs: number,
  deps: CollectDeps = {},
): Promise<{ qualifyingSessions: number; willScore: number }> {
  const scan = deps.scan ?? ((dirs) => scanSessionsCached(nowMs, dirs));
  const stats = await scan(dir ? { claudeDir: dir } : undefined);
  const cutoff = nowMs - WINDOW_DAYS * 24 * 3600 * 1000;
  const n = stats.filter((s) => s.endMs >= cutoff && s.endMs <= nowMs && s.msgs >= MIN_MSGS).length;
  return { qualifyingSessions: n, willScore: Math.min(n, SAMPLE_CAP) };
}

export async function collectGemitInputs(
  dir: string | undefined,
  nowMs: number,
  deps: CollectDeps = {},
): Promise<{ qualifying: GemitSessionInput[]; scored: GemitScoredInput[] }> {
  const scan = deps.scan ?? ((dirs) => scanSessionsCached(nowMs, dirs));
  const summarize = deps.summarize ?? ((id, agent, dirs) => summarizeSession(id, agent, dirs));
  const hygieneFor = deps.hygieneFor ?? defaultHygieneFor;

  // Only pass dirs when a custom home was requested — a custom dirs argument
  // bypasses the module-level scan cache, which per-session summarizeSession
  // calls rely on to avoid re-walking every transcript (O(N²) otherwise).
  const dirs = dir ? { claudeDir: dir } : undefined;
  const stats = await scan(dirs);

  const cutoff = nowMs - WINDOW_DAYS * 24 * 3600 * 1000;
  const inWindow = stats
    .filter((s) => s.endMs >= cutoff && s.endMs <= nowMs && s.msgs >= MIN_MSGS)
    .sort((a, b) => b.endMs - a.endMs);
  const qualifying = inWindow.map(toInput);

  const scored: GemitScoredInput[] = [];
  for (const s of inWindow.slice(0, SAMPLE_CAP)) {
    const isClaude = s.agent === "claude";
    const [summary, hygiene] = await Promise.all([
      summarize(s.sessionId, s.agent, dirs),
      isClaude ? hygieneFor(s.sessionId, dir) : Promise.resolve(null),
    ]);
    scored.push({
      session: toInput(s),
      hygieneScore: hygiene?.score ?? null,
      hygieneVerdict: hygiene?.verdict ?? null,
      processScore: summary?.process?.score ?? null,
      processLabel: summary?.process?.label ?? null,
      findings: [
        ...(hygiene?.findings ?? []),
        ...(summary?.findings ?? []).map((f) => ({ id: f.id, title: f.title, count: f.count })),
      ],
      verifications: summary?.events?.verifications ?? null,
    });
  }
  return { qualifying, scored };
}

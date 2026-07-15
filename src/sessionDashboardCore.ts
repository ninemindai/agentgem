// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/sessionDashboardCore.ts
//
// Per-session dashboard input: resolve one completed Claude session and shape
// its event series for the one-shot renderDashboard pass (Inspect → Session ·
// Dashboard lens). Mirrors sessionBlastCore: guard failures are tagged so the
// controller maps exactly these to a clean `failed` event / 400 class.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  claudeSessionEvents, codexSessionEvents, resolveClaudeSession, resolveCodexSession,
  dashboardToken, type SessionEvent, type BlastReport,
} from "@agentgem/insight";

export class DashboardInputError extends Error {}

// The live watch path feeds renderDashboard small bursts (≤ ~40 events); a whole
// historical session can be thousands of events with long message text. Bound the
// prompt: clip each span's free-text fields, and keep the session's head (the
// task) + tail (the outcome) when the middle would blow the window. The cut is
// marked with a synthetic message so the agent knows it saw a summary, not all.
const CLIP = 400;
const HEAD = 20, TAIL = 120;

function clip(s: string): string {
  return s.length > CLIP ? s.slice(0, CLIP) + "…" : s;
}

export function capDashboardEvents(events: SessionEvent[]): SessionEvent[] {
  const clipped = events.map((e): SessionEvent => {
    const sp = e.span;
    if (sp.kind === "message") return { ...e, span: { ...sp, text: clip(sp.text) } };
    if (sp.kind === "tool_call") return { ...e, span: { ...sp, input: clip(sp.input) } };
    return { ...e, span: { ...sp, output: clip(sp.output) } };
  });
  if (clipped.length <= HEAD + TAIL) return clipped;
  const omitted = clipped.length - HEAD - TAIL;
  const marker: SessionEvent = {
    tsMs: clipped[HEAD].tsMs,
    span: { kind: "message", role: "user", text: `[… ${omitted} events omitted …]` },
  };
  return [...clipped.slice(0, HEAD), marker, ...clipped.slice(clipped.length - TAIL)];
}

export interface SessionDashboardInput {
  path: string;                 // transcript path (for the cache token)
  token: string;                // dashboardToken(path)
  project: string | null;       // cwd basename — display name only, never the full path
  events: SessionEvent[];       // capped, ordered
}

// ── Report facts (kind=report) ───────────────────────────────────────────────
// The long-form editorial report (renderReport / the agentgem-report contract,
// same engine as the rubric reports and the context-bloat mockup family) wants
// DETERMINISTIC FACTS, not raw events: session basics, the hygiene readout
// (Claude only — codex carries no per-turn window accounting), and a blast
// summary. Everything here is already scrubbed by the underlying cores.
const TOP_TARGETS = 12;
const TOP_COMMANDS = 10;
const CURVE_POINTS = 240;

export function blastFacts(rep: BlastReport): Record<string, unknown> {
  type Tally = { target: string; zone?: string; visits: number; edited: boolean; errors: number };
  const files = new Map<string, Tally>();
  const commands = new Map<string, number>();
  const skills = new Set<string>();
  const agents = new Set<string>();
  let errors = 0, outside = 0;
  for (const e of rep.events) {
    if (e.error) errors++;
    if (e.zone && e.target) {
      const key = `${e.zone}|${e.target}`;
      let t = files.get(key);
      if (!t) { t = { target: e.target, zone: e.zone, visits: 0, edited: false, errors: 0 }; files.set(key, t); }
      t.visits++;
      if (e.action === "edit") t.edited = true;
      if (e.error) t.errors++;
    } else if (e.action === "exec" && e.target) {
      commands.set(e.target, (commands.get(e.target) ?? 0) + 1);
    } else if (e.action === "skill" && e.target) skills.add(e.target);
    else if (e.action === "agent" && e.target) agents.add(e.target);
  }
  const all = [...files.values()];
  outside = all.filter((t) => t.zone !== "project").length;
  return {
    events: rep.events.length,
    filesTouched: all.length,
    edited: all.filter((t) => t.edited).length,
    outsideProject: outside,
    errors,
    topTargets: all.sort((a, b) => b.visits - a.visits).slice(0, TOP_TARGETS),
    topCommands: [...commands.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_COMMANDS)
      .map(([verb, count]) => ({ verb, count })),
    skills: [...skills].sort(),
    subagents: [...agents].sort(),
  };
}

/** Downsample a hygiene curve to at most `max` points, always keeping the last. */
export function downsampleCurve<T>(curve: T[], max = CURVE_POINTS): T[] {
  if (curve.length <= max) return curve;
  const step = Math.ceil(curve.length / max);
  const out = curve.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== curve[curve.length - 1]) out.push(curve[curve.length - 1]);
  return out;
}

export async function resolveSessionDashboardInput(id: string, agent: string): Promise<SessionDashboardInput> {
  if (agent !== "claude" && agent !== "codex") throw new DashboardInputError(`Session dashboards are not available for agent '${agent}'.`);
  const found = agent === "claude" ? await resolveClaudeSession(id) : await resolveCodexSession(id);
  if (!found) throw new DashboardInputError(`No ${agent === "claude" ? "Claude" : "Codex"} session '${id}' found.`);
  const text = await readFile(found.path, "utf8");
  const extract = agent === "claude" ? claudeSessionEvents : codexSessionEvents;
  const events = capDashboardEvents(extract(text, found.path));
  if (events.length === 0) throw new DashboardInputError("This session has no readable events to render.");
  return {
    path: found.path,
    token: dashboardToken(found.path),
    project: found.cwd ? basename(found.cwd) : null,
    events,
  };
}

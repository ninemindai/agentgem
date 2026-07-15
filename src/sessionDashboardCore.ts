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
import { claudeSessionEvents, resolveClaudeSession, dashboardToken, type SessionEvent } from "@agentgem/insight";

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

export async function resolveSessionDashboardInput(id: string, agent: string): Promise<SessionDashboardInput> {
  if (agent !== "claude") throw new DashboardInputError("Session dashboards are available for Claude sessions only.");
  const found = await resolveClaudeSession(id);
  if (!found) throw new DashboardInputError(`No Claude session '${id}' found.`);
  const text = await readFile(found.path, "utf8");
  const events = capDashboardEvents(claudeSessionEvents(text, found.path));
  if (events.length === 0) throw new DashboardInputError("This session has no readable events to render.");
  return {
    path: found.path,
    token: dashboardToken(found.path),
    project: found.cwd ? basename(found.cwd) : null,
    events,
  };
}

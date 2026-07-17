// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/home.controller.ts
//
// The first-run "reveal" home screen composes several read-only signals into ONE
// endpoint so the UI doesn't have to fan out N requests before it can render:
// usage totals (Claude+Codex, via the same scanSessionsCached aggregation the
// Overview/observe routes already use), the Claude-only fire-gate input, whether a
// scorecard is already cached (so the reveal can pre-fill stale instead of blocking
// on a fresh scan), and honest scope (how many projects would be scanned vs the
// perf cap). NOTE: src/usage/reporter.ts is the signed-in aggregator POST
// side-effect — deliberately NOT reused here; this is a read model only.
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { scanSessionsCached, readAnalysisCacheLatest } from "@agentgem/insight";
import { selectScorecardRoots, SCORECARD_CACHE_ROOT, MAX_PROJECTS } from "./gem/scorecard.js";
import { agentgemHome } from "@agentgem/model";
import { listWorkspaces } from "@agentgem/base";
import { readState, persistUnlock, persistRevealSeen, type HomeState } from "./home/state.js";

// The Claude-only session count below which the reveal's "you have a goldmine"
// framing shouldn't fire — too little Claude history to back the claim. Defined
// server-side (not left to the console) so the gate can't be tricked by a stale
// or forged client-side count.
export const CLAUDE_GATE_MIN_SESSIONS = 10;

const DAY_MS = 86_400_000;

const HomeSummarySchema = z.object({
  usage: z.object({
    sessions: z.number(),
    spanDays: z.number(),
    activeMs: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
    tokensCache: z.number(),
  }),
  claudeSessions: z.number(),
  gate: z.object({
    usageEmpty: z.boolean(),
    claudeBelowGate: z.boolean(),
  }),
  scorecardCached: z.boolean(),
  projectsScanned: z.number(),
  projectsCap: z.number(),
});

const HomeStateSchema = z.object({
  unlocked: z.boolean(),
  existingUser: z.boolean(),
  revealSeen: z.boolean(),
});
const HomeStateBodySchema = z.object({
  unlocked: z.boolean().optional(),
  revealSeen: z.boolean().optional(),
});

// Unlock is server-derived and one-way: unlocked = unlockedAt set OR existingUser OR
// (≥1 gem exists). The gem check reuses listWorkspaces() — the same lookup GET
// /api/workspaces (the console's gems list) is built on — so deleting the last gem never
// re-locks: the first time the OR is true, unlockedAt latches permanently.
function resolveHomeState(base: string): HomeState {
  let s = readState(base);
  const gemsExist = listWorkspaces().length > 0;
  const unlocked = !!s.unlockedAt || !!s.existingUser || gemsExist;
  if (unlocked && !s.unlockedAt) s = persistUnlock(s, base);
  return s;
}
function toResponse(s: HomeState): z.infer<typeof HomeStateSchema> {
  return { unlocked: !!s.unlockedAt, existingUser: !!s.existingUser, revealSeen: !!s.revealSeenAt };
}

@api({ basePath: "/api" })
export class HomeController {
  @get("/home/summary", { response: HomeSummarySchema })
  async summary(): Promise<z.infer<typeof HomeSummarySchema>> {
    const stats = await scanSessionsCached(Date.now());
    let tokensIn = 0, tokensOut = 0, tokensCache = 0, activeMs = 0, claudeSessions = 0;
    let firstMs = Infinity, lastMs = -Infinity;
    for (const s of stats) {
      tokensIn += s.tokensIn;
      tokensOut += s.tokensOut;
      tokensCache += s.tokensCache;
      activeMs += Math.max(0, s.endMs - s.startMs);
      firstMs = Math.min(firstMs, s.startMs);
      lastMs = Math.max(lastMs, s.endMs);
      if (s.agent === "claude") claudeSessions++;
    }
    const usage = {
      sessions: stats.length,
      spanDays: stats.length ? Math.round((lastMs - firstMs) / DAY_MS) : 0,
      activeMs, tokensIn, tokensOut, tokensCache,
    };
    return {
      usage,
      claudeSessions,
      gate: {
        usageEmpty: usage.sessions === 0,
        claudeBelowGate: claudeSessions < CLAUDE_GATE_MIN_SESSIONS,
      },
      scorecardCached: readAnalysisCacheLatest(SCORECARD_CACHE_ROOT) !== null,
      // Cheap discovery only (no transcript scan) — the same capped root list
      // collectScorecard would use, so the count is truthful without the cost.
      projectsScanned: selectScorecardRoots(undefined, undefined).length,
      projectsCap: MAX_PROJECTS,
    };
  }

  @get("/home/state", { response: HomeStateSchema })
  async state(): Promise<z.infer<typeof HomeStateSchema>> {
    return toResponse(resolveHomeState(agentgemHome()));
  }

  // One-way only: `false` is ignored (no unset path exists), so a client can only ever
  // move these flags from unset to set, never back.
  @post("/home/state", { body: HomeStateBodySchema, response: HomeStateSchema })
  async setState(input: { body: z.infer<typeof HomeStateBodySchema> }): Promise<z.infer<typeof HomeStateSchema>> {
    const base = agentgemHome();
    let s = resolveHomeState(base);
    if (input.body.unlocked) s = persistUnlock(s, base);
    if (input.body.revealSeen) s = persistRevealSeen(s, base);
    return toResponse(s);
  }
}

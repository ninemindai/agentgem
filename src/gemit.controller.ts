// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit.controller.ts
//
// The console's Gemit screen: score the local window and publish the card without ever
// leaving the app. Both jobs need the local producer keypair (postGemPublish signs the
// manifest with it), which a file:// report can never reach — that is the whole reason
// this lives behind an HTTP route instead of a button in the generated HTML.
//
// This controller sits in the ROOT package rather than @agentgem/app because the gemit
// module it drives lives here, and @agentgem/app must not depend on the root. It is
// registered by src/client.ts, which is the entry that serves the local console.
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { loadOrCreateIdentity } from "@agentgem/model";
import { readBindingStatus } from "@agentgem/app/bind/bindCore";
import { postGemPublish } from "@agentgem/app/gem/gemPublishClient";
import { collectGemitInputs, countGemitWindow } from "./gemit/collect.js";
import { computeGemitData, type GemitData } from "./gemit/score.js";
import { renderRpgTheme, TIER_NAMES } from "./gemit/themeRpg.js";
import { buildGemitShare, gemitShareUrls } from "./gemit/share.js";

const Report = z.object({
  /** Rendered sealed — the panel frames this in sandbox="allow-scripts", where no link
   *  could navigate anyway, and the panel owns the real share affordances in React. */
  html: z.string(),
  insufficient: z.boolean(),
  tier: z.string(),
  composite: z.number(),
  ctx: z.number(),
  proc: z.number(),
  setup: z.number(),
  qualifyingSessions: z.number(),
  scoredSessions: z.number(),
  projects: z.number(),
  windowFrom: z.string(),
  windowTo: z.string(),
  /** Whether an account is bound, i.e. whether publishing can name a card at all. */
  bound: z.boolean(),
  login: z.string().nullable(),
});

const Window = z.object({ qualifyingSessions: z.number(), willScore: z.number() });

const PublishBody = z.object({
  /** Ship coding agents + skill/subagent names too. Mirrors the CLI's --include-usage;
   *  the panel must show the matching consent copy when this is on. */
  includeUsage: z.boolean().default(false),
});

const PublishResult = z.object({
  published: z.boolean(),
  reason: z.string().nullable(),
  shareUrl: z.string().nullable(),
  x: z.string().nullable(),
  linkedin: z.string().nullable(),
  facebook: z.string().nullable(),
});

const rejected = (reason: string): z.infer<typeof PublishResult> =>
  ({ published: false, reason, shareUrl: null, x: null, linkedin: null, facebook: null });

interface GemitDeps {
  score: () => Promise<GemitData>;
  window: () => Promise<z.infer<typeof Window>>;
  binding: typeof readBindingStatus;
  publish: typeof postGemPublish;
}

const realDeps: GemitDeps = {
  score: async () => {
    const now = Date.now();
    const { qualifying, scored } = await collectGemitInputs(undefined, now);
    return computeGemitData(qualifying, scored, now);
  },
  window: () => countGemitWindow(undefined, Date.now()),
  binding: readBindingStatus,
  publish: postGemPublish,
};

// Test seam, mirroring setInsightsComputeForTests: the real path walks 30 days of
// transcripts off disk, which no unit test should do just to exercise a guard clause.
let overrides: Partial<GemitDeps> | null = null;
export const setGemitDepsForTests = (d: Partial<GemitDeps> | null): void => { overrides = d; };
const deps = (): GemitDeps => ({ ...realDeps, ...(overrides ?? {}) });

@api({ basePath: "/api/gemit" })
export class GemitController {
  // Enumerate-only, so the panel can name the work rather than spinning blind. Sub-second
  // warm, ~11s cold while the scan cache builds — either way it lands well before /report,
  // which additionally walks every sampled session.
  @get("/window", { response: Window })
  async window(): Promise<z.infer<typeof Window>> {
    return deps().window();
  }

  @get("/report", { response: Report })
  async report(): Promise<z.infer<typeof Report>> {
    const d = deps();
    const data = await d.score();
    const st = d.binding();
    return {
      html: renderRpgTheme(data, { sealed: true }),
      insufficient: data.insufficient,
      tier: data.insufficient ? "" : TIER_NAMES[data.tierLevel - 1],
      composite: data.composite,
      ctx: data.ctx, proc: data.proc, setup: data.setup,
      qualifyingSessions: data.qualifyingSessions,
      scoredSessions: data.scoredSessions,
      projects: data.projects,
      windowFrom: data.windowFrom, windowTo: data.windowTo,
      bound: Boolean(st.bound && st.login),
      login: st.login ?? null,
    };
  }

  // Re-scores rather than trusting anything the browser sends back. The window is
  // deterministic, so this reproduces the same card the panel is showing — and a client
  // that could post its own numbers could publish a card that lies about them.
  @post("/publish", { body: PublishBody, response: PublishResult })
  async publish(input: { body: z.infer<typeof PublishBody> }): Promise<z.infer<typeof PublishResult>> {
    const d = deps();
    const st = d.binding();
    if (!st.bound || !st.login) return rejected("not-bound");

    const data = await d.score();
    if (data.insufficient) return rejected("insufficient");

    const built = buildGemitShare({ data, login: st.login, includeUsage: input.body.includeUsage });
    const res = await d.publish({
      manifest: built.manifest, archiveBase64: built.archiveBase64, identity: loadOrCreateIdentity(),
    });
    if (!res.shared) return rejected(res.rejected);
    return { published: true, reason: null, ...gemitShareUrls(built.gemKey, data) };
  }
}

// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit/share.ts
//
// `agentgem gemit --share` packaging: derive the privacy-stripped share variant
// of a GemitData payload, render it, and wrap the HTML as a one-artifact game
// gem plus the signed catalog manifest. Pure — no filesystem, no network — the
// CLI owns confirmation and the actual POST (postGemPublish).
import type { GameArtifact, Gem } from "@agentgem/model";
import { exportGem, importGem } from "@agentgem/distribute";
import type { CatalogManifest } from "@agentgem/contract";
import type { GemitData } from "./score.js";
import { GEMIT_CMD, renderRpgTheme, TIER_NAMES, type RpgRenderOpts, type ShareLinks } from "./themeRpg.js";
import { COHORT, topPercentFor, type Cohort } from "./cohort.js";

// Bumped to 1.1.0 when SETUP's variety terms moved to a log curve (see score.ts). The
// numbers on a card are immutable once published, so this is the only thing that records
// which formula produced them.
export const GEMIT_SHARE_VERSION = "1.1.0";
const MARKETPLACE_BASE = "https://app.agentgem.ai"; // mirrors the Studio publish toast

// The local report may name the operator's skills/subagents; the shared copy must
// not (the theme embeds the full payload as a JSON island). Variety COUNTS stay —
// they are what the perks derive from.
export function shareVariantOf(data: GemitData, opts: { includeUsage?: boolean } = {}): GemitData {
  // `agents` joins the strip not because agent names are sensitive — they are a fixed
  // public vocabulary — but because the consent line the CLI prints promises "scores,
  // counts, window dates" and nothing else.
  //
  // includeUsage widens exactly this, and only when the operator asked for it on the
  // command line. Project names and transcripts are NOT reachable from here under any
  // flag — they never enter GemitData in the first place, so the remaining half of that
  // promise is structural rather than a policy this function could relax.
  if (opts.includeUsage) return { ...data };
  return { ...data, topSkills: [], topSubagents: [], agents: [] };
}

export function buildGemitShare(args: {
  data: GemitData;
  login: string;
  /** Operator opted in (--include-usage) to shipping coding agents + skill/subagent names. */
  includeUsage?: boolean;
  render?: (d: GemitData, opts?: RpgRenderOpts) => string;
}): { gemKey: string; version: string; html: string; archiveBase64: string; manifest: CatalogManifest } {
  const shareData = shareVariantOf(args.data, { includeUsage: args.includeUsage });
  // `sealed` — this copy is played inside the marketplace's `sandbox="allow-scripts"`
  // frame, where an outbound link cannot navigate. Share affordances belong on the local
  // report (which the CLI re-renders post-publish), never on the artifact that ships.
  const html = (args.render ?? renderRpgTheme)(shareData, { sealed: true });
  const name = `gemit-${args.data.windowTo}`;
  const gemKey = `${args.login}/${name}`;
  const tierName = TIER_NAMES[args.data.tierLevel - 1];

  const artifact: GameArtifact = {
    type: "game", name, title: `${tierName} — Agent Steering Report`,
    genre: "session-heatmap", html,
    createdFrom: { kind: "html", title: "agentgem gemit steering report" },
    engineVersion: "gemit-rpg-1",
  };
  const gem: Gem = { name, createdFrom: "gemit", artifacts: [artifact], checks: [], requiredSecrets: [] };
  const { bytes } = exportGem(gem, { version: GEMIT_SHARE_VERSION });
  const { meta } = importGem(bytes); // same round-trip publishSetup does: digest binds the signature

  const manifest: CatalogManifest = {
    gemKey, version: GEMIT_SHARE_VERSION, visibility: "unlisted", tags: ["gemit"],
    description: `Agent steering assessment ${args.data.windowFrom} → ${args.data.windowTo}: ` +
      `${tierName}, ${args.data.composite}/100. Scored ${args.data.scoredSessions} of ` +
      `${args.data.qualifyingSessions} sessions.`,
    artifactKinds: ["game"],
    artifacts: [{ name, type: "game" }],
    gemDigest: meta.gemDigest,
  };
  return { gemKey, version: GEMIT_SHARE_VERSION, html, archiveBase64: bytes.toString("base64"), manifest };
}

// The "top N%" NUMBER is single-sourced in cohort.ts's topPercentFor, so the card
// (themeRpg.ts) and this share text can never disagree on the number itself. This
// wrapper only owns the string shape (the ", top N%" clause), pulled out as its own
// function (rather than inlined in gemitShareUrls) so the cohort-present path is
// directly testable with a hand-built table, not just the cohort-absent one.
export function standingClause(composite: number, c?: Cohort | null): string {
  const pct = topPercentFor(composite, c);
  return pct === null ? "" : `, top ${pct}%`;
}

export function gemitShareUrls(gemKey: string, data: GemitData): ShareLinks {
  const shareUrl = `${MARKETPLACE_BASE}/games/${gemKey}`;
  const tierName = TIER_NAMES[data.tierLevel - 1];
  const standing = standingClause(data.composite, COHORT);
  // The command sits between the hook and the URL, not after it: X unfurls a post's LAST
  // link, so keeping shareUrl final preserves the card preview. GEMIT_CMD is the same
  // constant the report and CLI use, so the invocation can never drift across surfaces —
  // and it is npx-prefixed, which matters most here: a reader who has never installed
  // anything is exactly who this line is for.
  const text = `${tierName} — ${data.composite}/100${standing} on agent steering. What's your level?\n`
    + `${GEMIT_CMD}\n${shareUrl}`;
  const u = encodeURIComponent(shareUrl);
  return {
    shareUrl,
    x: `https://x.com/intent/post?text=${encodeURIComponent(text)}`,
    // LinkedIn and Facebook accept a URL and nothing else — both compose their preview
    // from the /games OG card and silently drop any text parameter. The tier/score line
    // therefore rides on X alone; there is no point threading `text` through these two.
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
  };
}

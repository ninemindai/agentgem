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
import { renderRpgTheme, TIER_NAMES, type RpgRenderOpts, type ShareLinks } from "./themeRpg.js";
import { COHORT, topPercentFor, type Cohort } from "./cohort.js";

export const GEMIT_SHARE_VERSION = "1.0.0";
const MARKETPLACE_BASE = "https://app.agentgem.ai"; // mirrors the Studio publish toast

// The local report may name the operator's skills/subagents; the shared copy must
// not (the theme embeds the full payload as a JSON island). Variety COUNTS stay —
// they are what the perks derive from.
export function shareVariantOf(data: GemitData): GemitData {
  // `agents` joins the strip not because agent names are sensitive — they are a fixed
  // public vocabulary — but because the consent line the CLI prints promises "scores,
  // counts, window dates" and nothing else. Widening that is an opt-in, and an opt-in
  // has to change the consent text in the same breath.
  return { ...data, topSkills: [], topSubagents: [], agents: [] };
}

export function buildGemitShare(args: {
  data: GemitData;
  login: string;
  render?: (d: GemitData, opts?: RpgRenderOpts) => string;
}): { gemKey: string; version: string; html: string; archiveBase64: string; manifest: CatalogManifest } {
  const shareData = shareVariantOf(args.data);
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
  const text = `${tierName} — ${data.composite}/100${standing} on agent steering. What's your level?\n${shareUrl}`;
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

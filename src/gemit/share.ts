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
import { renderRpgTheme, TIER_NAMES } from "./themeRpg.js";

export const GEMIT_SHARE_VERSION = "1.0.0";
const MARKETPLACE_BASE = "https://app.agentgem.ai"; // mirrors the Studio publish toast

// The local report may name the operator's skills/subagents; the shared copy must
// not (the theme embeds the full payload as a JSON island). Variety COUNTS stay —
// they are what the perks derive from.
export function shareVariantOf(data: GemitData): GemitData {
  return { ...data, topSkills: [], topSubagents: [] };
}

export function buildGemitShare(args: {
  data: GemitData;
  login: string;
  render?: (d: GemitData) => string;
}): { gemKey: string; version: string; html: string; archiveBase64: string; manifest: CatalogManifest } {
  const shareData = shareVariantOf(args.data);
  const html = (args.render ?? renderRpgTheme)(shareData);
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

export function gemitShareUrls(gemKey: string, data: GemitData): { shareUrl: string; xIntentUrl: string } {
  const shareUrl = `${MARKETPLACE_BASE}/games/${gemKey}`;
  const tierName = TIER_NAMES[data.tierLevel - 1];
  const text = `${tierName} — ${data.composite}/100 on agent steering. What's your level?\n${shareUrl}`;
  return { shareUrl, xIntentUrl: `https://x.com/intent/post?text=${encodeURIComponent(text)}` };
}

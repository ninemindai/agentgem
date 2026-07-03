// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/curatedSources.ts
//
// A curated list of external repos AgentGem can import from to bootstrap the Gem registry.
// Each entry is a trusted, license-clear repo of persona/skill markdown; the console/agent
// browses it and imports selected items as skill artifacts (see agencyAgents.ts for the
// agency-layout adapter). Adding a same-layout source is one more entry here; a differently
// shaped repo needs its own adapter + a new `kind`.
import type { GithubCfg } from "./registryGithub.js";

// The on-disk layout a source uses, which selects the import adapter. Only one today.
export type CuratedSourceKind = "agency-layout";

export interface CuratedSource {
  id: string;            // stable slug, e.g. "agency-agents"
  label: string;         // display name
  description: string;   // one-line for the picker
  repo: string;          // GitHub "owner/name"
  ref: string;           // branch/tag/sha
  kind: CuratedSourceKind;
  license?: string;      // SPDX-ish, e.g. "MIT"
  homepage?: string;     // canonical URL for attribution
}

export const CURATED_SOURCES: CuratedSource[] = [
  {
    id: "agency-agents",
    label: "The Agency",
    description:
      "232 curated role personas across 16 divisions (engineering, design, marketing, security…) by @msitarzewski.",
    repo: "msitarzewski/agency-agents",
    ref: "main",
    kind: "agency-layout",
    license: "MIT",
    homepage: "https://github.com/msitarzewski/agency-agents",
  },
];

export function curatedSourceById(id: string): CuratedSource | undefined {
  return CURATED_SOURCES.find((s) => s.id === id);
}

// GitHub client config for a curated source. Token-optional: public repos resolve anonymously;
// GITHUB_TOKEN (when present) only lifts the 60/hr unauthenticated rate limit.
export function cfgForCuratedSource(source: CuratedSource): GithubCfg {
  return { repo: source.repo, ref: source.ref, token: process.env.GITHUB_TOKEN };
}

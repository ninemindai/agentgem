// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Shared registry types used across @agentgem/distribute. Pulled out into their own module so
// other modules in this package can depend on the shapes without depending on the registry
// resolve/publish logic or the GitHub client that produce/consume them.

// ── registry index shapes (produced/consumed by registry.ts) ───────────────
export interface RegistryItemVersion { path: string; gemDigest: string; dependencies: string[] }
// Denormalized, searchable metadata for the latest version — additive/optional so older
// readers ignore it and the format version need not bump. Populated at publish time.
export interface RegistryItemDiscovery {
  description?: string;
  tags?: string[];
  author?: string;
  artifactKinds?: string[];
  updatedAt?: string;
  type?: string;        // the gem's cut (setup/kit/skill/integration/guide/playbook + plugin cuts)
  publishedBy?: string; // server-verified GitHub login of the publishing account (distinct from free-form `author`)
  grade?: number;       // authoring-quality floor (1..3) forwarded from the gem; the marketplace blends it with stars
}
export interface RegistryItem { latest: string; versions: Record<string, RegistryItemVersion>; discovery?: RegistryItemDiscovery }
export interface RegistryIndex { formatVersion: number; items: Record<string, RegistryItem> }

// ── GitHub client shapes (for GitHub-backed sources) ───────────────────────
export interface GithubCfg { repo: string; ref: string; token?: string }
export type Http = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text: () => Promise<string> }>;

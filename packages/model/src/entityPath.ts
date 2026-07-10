// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/model/src/entityPath.ts
//
// Canonical entity paths, per docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md
// (on the unmerged `docs/entity-address-scheme` branch). This is that scheme's FIRST conformer and
// deliberately implements only the `workspace/*` collections it needs — other collections get added
// by whoever conforms them next, rather than shipping builders with no caller.
//
// Two deviations from the written scheme, both forced by real data:
//  - A `source` segment. Plugin artifact names are BARE (`code-reviewer` from
//    `plugin:feature-dev@…`), so `workspace/skills/<name>` cannot distinguish two plugins shipping
//    one name. Rule 2 of the scheme — nesting expresses containment — makes a source a container.
//  - Percent-encoded segments. The instruction `codex:rules/default.rules` already contains a '/',
//    which would otherwise split the path.
//
// `instructions` carry no `source` (introspect yields type/name/content only), so their path has
// THREE segments where skills and subagents have four. The parser branches on the collection rather
// than inferring from segment count, and rather than inventing a fake `source: "local"` to keep the
// shape rectangular. This asymmetry is intentional; it is not a bug to be cleaned up.

export const WORKSPACE_COLLECTIONS = ["skills", "subagents", "instructions"] as const;
export type WorkspaceCollection = (typeof WORKSPACE_COLLECTIONS)[number];

/** Artifact `type` -> workspace collection. Body-less types (hook, mcp_server) are absent by design. */
const COLLECTION_OF: Record<string, WorkspaceCollection> = {
  skill: "skills",
  subagent: "subagents",
  instructions: "instructions",
};

/** Canonical id for a local, gem-less artifact. null when the type has no body to address. */
export function workspaceArtifactPath(a: { type: string; name: string; source?: string }): string | null {
  const collection = COLLECTION_OF[a.type];
  if (!collection) return null;
  if (collection === "instructions") return `workspace/instructions/${encodeURIComponent(a.name)}`;
  if (!a.source) return null; // a four-segment path needs a source segment
  return `workspace/${collection}/${encodeURIComponent(a.source)}/${encodeURIComponent(a.name)}`;
}

/** Inverse of workspaceArtifactPath. Returns null — never throws — so a bad id is a 404, not a 500. */
export function parseWorkspaceArtifactPath(
  id: string,
): { collection: WorkspaceCollection; source?: string; name: string } | null {
  const seg = id.split("/");
  if (seg[0] !== "workspace") return null;
  const collection = seg[1] as WorkspaceCollection;
  if (!WORKSPACE_COLLECTIONS.includes(collection)) return null;
  try {
    if (collection === "instructions") {
      if (seg.length !== 3) return null;
      return { collection, name: decodeURIComponent(seg[2]) };
    }
    if (seg.length !== 4) return null;
    return { collection, source: decodeURIComponent(seg[2]), name: decodeURIComponent(seg[3]) };
  } catch {
    return null; // decodeURIComponent throws URIError on a malformed %-escape
  }
}

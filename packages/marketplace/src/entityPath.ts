// packages/marketplace/src/entityPath.ts
// The canonical entity-address scheme: <plural-collection>/<entity-id>, rendered into this app's
// pathname space. See docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md.
//
// Sibling: packages/model/src/entityPath.ts implements the workspace/* half. This file cannot import
// it — the marketplace takes no workspace deps (see gems/cuts.ts). The two share the scheme, not a
// function, so there is nothing to keep in sync.
//
// Deviation from the sibling: game paths are NOT percent-encoded. Artifact names carry '/' as data,
// so workspaceArtifactPath must encode. A gem key carries '/' as structure (@scope/name, both
// [a-z0-9-]), and a copy-friendly link is this feature's whole point. We still DECODE on parse.

/** A published gem key: @scope/name, both segments [a-z0-9-] (see distribute/src/registry.ts). */
const PUBLISHED_KEY = /^@[a-z0-9-]+\/[a-z0-9-]+$/;

/** True for a published registry key. Scope-less keys are unlisted shares — unlistable by construction. */
export function isPublishedKey(key: string): boolean {
  return PUBLISHED_KEY.test(key);
}

/** Keys are [a-z0-9-@/] only, so no percent-encoding is needed and the URL stays copy-friendly. */
export function gamePath(key: string): string {
  return `/games/${key}`;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed %-escape: hand it back rather than throw inside the Router
  }
}

/** The gem key addressed by a /games/... pathname, or null if this isn't one. */
export function parseGamePath(pathname: string): string | null {
  const m = pathname.match(/^\/games\/(.+)$/);
  return m ? safeDecode(m[1]) : null;
}

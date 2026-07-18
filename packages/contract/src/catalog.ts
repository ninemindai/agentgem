// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The neutral catalog wire-contract: the pure types + signing-payload builders that both the
// hosted aggregator and the local dev-app client share. No DB, no auth — the aggregator imports
// these back and adds the DB layer; the local client imports them to sign requests it sends over HTTP.
import { createHash } from "node:crypto";
import { canonicalJSON } from "@agentgem/insight";

export type Visibility = "public" | "unlisted" | "private";

export interface GemArtifactRef { name: string; type: string }
export interface CatalogRow {
  gemKey: string; version: string; publishedBy: string;
  author?: string; description?: string; tags?: string[]; artifactKinds?: string[];
  type?: string; grade?: number; createdAtMs: number; updatedAtMs?: number;
  artifacts?: GemArtifactRef[];
  installable?: boolean; // derived: a gem_archives row exists (read path only)
  ownerAccountId?: string | null;
  visibility?: Visibility;
}

export interface GemStatus { exists: boolean; ownedByMe: boolean; latestVersion: string | null }

// Signed payload for a gem-status pre-flight query. Mirrors catalogSigningPayload but commits to
// the queried key (not a full manifest), so resolveSignedAccount can attribute the request.
export function gemStatusSigningPayload(gemKey: string, pubkey: string, signedAt: number): string {
  return canonicalJSON({ pubkey, signedAt, gemKey });
}

// Signed payload for the /my-gems listing query. Mirrors gemStatusSigningPayload's shape but has no
// key to commit to — it's just "prove key possession right now" so resolveSignedAccount can attribute
// the request to an accountId.
export function myGemsSigningPayload(pubkey: string, signedAt: number): string {
  return canonicalJSON({ action: "my-gems", pubkey, signedAt });
}

export interface CatalogManifest {
  gemKey: string; version: string; author?: string; description?: string;
  tags?: string[]; artifactKinds?: string[]; type?: string; grade?: number;
  // Set by the archive-publish path: the per-artifact preview list and the archive's content
  // digest. Both are inside the signed manifest, so the signature binds the publish to this archive.
  artifacts?: GemArtifactRef[]; gemDigest?: string;
  visibility?: Visibility;
}

// Grade is a 1..3 floor. Exported so the read path (mapDbToGems) can re-clamp defensively —
// an out-of-band DB write with an out-of-range grade must not 500 the public catalog via the
// response schema's min(1).max(3). NaN-safe: a non-numeric grade collapses to undefined.
export const clampGrade = (g?: number): number | undefined =>
  g === undefined || Number.isNaN(g) ? undefined : Math.max(1, Math.min(3, Math.trunc(g)));

// Sign over a hash of the manifest so the canonical (loggable) payload stays compact and stable.
export function catalogSigningPayload(m: CatalogManifest, pubkey: string, signedAt: number): string {
  const manifestHash = createHash("sha256").update(canonicalJSON(m)).digest("hex");
  return canonicalJSON({ pubkey, signedAt, manifestHash });
}

// Canonical payload for a review-staging action that has no manifest to sign (approve/changes/
// withdraw/seen/get/archive/message/inbox). Binds the action verb + target request id so a captured
// signature for one action can't be replayed as another. `requestId` is "" for the inbox list.
export function reviewActionPayload(action: string, requestId: string, pubkey: string, signedAt: number): string {
  return canonicalJSON({ scope: "review", action, requestId, pubkey, signedAt });
}

// Canonical payload for /review/request. A distinct `scope` from catalogSigningPayload (which
// /publish-gem and /catalog also verify) so a captured submit body can never be replayed as a
// publish, and binding `groupId` stops it being redirected to stage the same signed manifest under
// a different group.
export function reviewSubmitPayload(m: CatalogManifest, groupId: string, pubkey: string, signedAt: number): string {
  const manifestHash = createHash("sha256").update(canonicalJSON(m)).digest("hex");
  return canonicalJSON({ scope: "review-submit", manifestHash, groupId, pubkey, signedAt });
}

// Canonical payload for /review/resubmit. Distinct `scope` from both catalogSigningPayload and
// reviewSubmitPayload, and binds `requestId` (not groupId — resubmit targets an existing request,
// not a group) so submit and resubmit signatures can never be swapped for one another.
export function reviewResubmitPayload(m: CatalogManifest, requestId: string, pubkey: string, signedAt: number): string {
  const manifestHash = createHash("sha256").update(canonicalJSON(m)).digest("hex");
  return canonicalJSON({ scope: "review-resubmit", manifestHash, requestId, pubkey, signedAt });
}

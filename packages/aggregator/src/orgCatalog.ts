// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Org scorecard catalog: all gems keyed @scope/* with a per-gem maturity rubric. Mirrors buildProfile
// (filters catalog_gems), but keys off the gem's SCOPE rather than published_by, and returns an EMPTY
// catalog (not null) for an unknown scope so the page shows a friendly empty state; null is reserved
// for a malformed scope → the route maps that to 400.
import { sql, desc } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { catalogGems, accountScopes } from "./schema.js";
import { accountIdForHandle } from "./handles.js";
import { starCounts } from "./stars.js";
import { gemAdoption } from "./aggregates.js";
import { computeGemRubric, type RubricResult } from "./orgRubric.js";

const SCOPE_RE = /^[A-Za-z0-9-]+$/; // GitHub login/org charset — no %/_ so LIKE-prefix is injection-safe

export interface OrgCatalogGem {
  key: string;
  version: string;
  cut: string | null;
  grade: number | null;
  owner: string;
  description: string | null;
  stars: number;
  installs: number;
  verifiedInstalls: number;
  rubric: RubricResult;
}
export interface OrgCatalog {
  scope: string;
  gemCount: number;
  ownerCount: number;
  gems: OrgCatalogGem[];
}

export async function buildOrgCatalog(db: AppDb, rawScope: string): Promise<OrgCatalog | null> {
  const scope = rawScope.trim();
  if (!SCOPE_RE.test(scope)) return null; // malformed → route returns 400

  const prefix = `@${scope}/%`.toLowerCase();
  // This endpoint is served anonymously (PUBLIC_READ_PATHS), so it must apply the same public-only
  // visibility filter as listCatalogGems — a private/unlisted gem's key/version/description must
  // never leak to an unauthenticated visitor of an org's catalog page.
  const rows = await db
    .select({ gemKey: catalogGems.gemKey, version: catalogGems.version, publishedBy: catalogGems.publishedBy,
              ownerAccountId: catalogGems.ownerAccountId, description: catalogGems.description,
              tags: catalogGems.tags, artifactKinds: catalogGems.artifactKinds, type: catalogGems.type, grade: catalogGems.grade })
    .from(catalogGems)
    .where(sql`lower(${catalogGems.gemKey}) like ${prefix} and ${catalogGems.visibility} = 'public'`)
    .orderBy(desc(catalogGems.createdAtMs), desc(catalogGems.version));

  // newest-first → dedupe to the latest version per gemKey (version tiebreak keeps it deterministic).
  const latest = new Map<string, typeof rows[number]>();
  for (const r of rows) if (!latest.has(r.gemKey)) latest.set(r.gemKey, r);
  const base = [...latest.values()];

  // Trust filter: a @scope/* gem renders on this org's page only if its OWNER actually owns `scope`
  // — either the owner is the account whose handle IS the scope (self), or account_scopes records
  // the ownership (their GitHub org membership, the same gate the publish path uses). Matching the
  // published_by STRING here would let anyone share a @scope/* gem through recordCatalogShare
  // (which does not verify scope ownership) and have it render under an official-looking org page.
  // (PR #99 review finding #1; the write-path gap is tracked as a separate follow-up.) Identity
  // re-key (task 7): the set is now uuids (owner_account_id), not login strings — an unresolved
  // gem (owner_account_id NULL) can never match and is excluded, closing the impersonation hole a
  // string compare left open for backfill rows that failed to resolve.
  const scopeLc = scope.toLowerCase();
  const owners = await db
    .select({ accountId: accountScopes.accountId })
    .from(accountScopes)
    .where(sql`lower(${accountScopes.scope}) = ${scopeLc}`);
  const ownerSet = new Set(owners.map((o) => o.accountId));
  const selfId = await accountIdForHandle(db, scope);
  if (selfId) ownerSet.add(selfId);
  const owned = base.filter((g) => g.ownerAccountId !== null && ownerSet.has(g.ownerAccountId));

  const keys = owned.map((g) => g.gemKey);
  const starMap = await starCounts(db, "gem", keys); // guards keys.length === 0 internally
  const adoptRows = keys.length ? await gemAdoption(db, { keys }) : [];
  const adopt = new Map(adoptRows.map((a) => [a.gemKey, a]));

  const gems: OrgCatalogGem[] = owned
    .map((g) => {
      const stars = starMap[g.gemKey] ?? 0;
      const installs = adopt.get(g.gemKey)?.installs ?? 0;
      const verifiedInstalls = adopt.get(g.gemKey)?.verifiedInstalls ?? 0;
      const rubric = computeGemRubric({ description: g.description, tags: g.tags, artifactKinds: g.artifactKinds, grade: g.grade, publishedBy: g.publishedBy, stars, installs });
      return { key: g.gemKey, version: g.version, cut: g.type, grade: g.grade, owner: g.publishedBy, description: g.description, stars, installs, verifiedInstalls, rubric };
    })
    .sort((a, b) => (b.grade ?? 0) - (a.grade ?? 0) || b.stars - a.stars || a.key.localeCompare(b.key));

  const ownerCount = new Set(gems.map((g) => g.owner.toLowerCase())).size;
  return { scope, gemCount: gems.length, ownerCount, gems };
}

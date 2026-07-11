// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Public profile assembly: one identity → avatar + verified flag + published gems with engagement.
// Ownership read (identity re-key, task 7): gems are matched by owner_account_id, not by the
// published_by display string — that string has no uniqueness constraint, and an unresolved gem
// (owner_account_id NULL) belongs to nobody. A profile now requires a claimed "user".handle; a
// bind-only account (device-flow only, no web sign-in) has no handle and no profile.
import { sql, desc, eq } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { accounts, catalogGems } from "./schema.js";
import { accountIdForHandle, handleForAccountId } from "./handles.js";
import { starCounts } from "./stars.js";
import { reviewsByAccount } from "./reviews.js";
import { skillNamesByTargetId } from "./curatedSkills.js";
import { gemAdoption } from "./aggregates.js";

const HANDLE_RE = /^[A-Za-z0-9-]{1,39}$/;

export interface ProfileGem {
  key: string;
  version: string;
  description: string | null;
  grade: number | null;
  stars: number;
  installs: number;
  verifiedInstalls: number;
}
export interface ProfileReview {
  sourceId: string;
  path: string;
  name: string;
  rating: number;
  body: string | null;
  createdAt: string;
}
export interface Profile {
  login: string;
  avatarUrl: string | null;
  verified: boolean;
  githubUrl: string | null;
  totalStars: number;
  gems: ProfileGem[];
  reviews: ProfileReview[];
}

// target_id "<sourceId>/<path>" → the concrete skill; name is the path basename sans .md.
// Fallback name when the target isn't in the curated index: the file basename, but a bare
// "SKILL.md" is named by its parent directory (the `<name>/SKILL.md` convention), not "SKILL".
function fallbackName(path: string, targetId: string): string {
  const segs = path.split("/").filter(Boolean);
  let base = (segs.pop() || path || targetId).replace(/\.md$/i, "");
  if (base.toUpperCase() === "SKILL" && segs.length > 0) base = segs[segs.length - 1]!;
  return base;
}

function parseSkillReview(
  r: { targetId: string; rating: number; body: string | null; createdAt: string },
  curatedName?: string,
): ProfileReview {
  const slash = r.targetId.indexOf("/");
  const sourceId = slash > 0 ? r.targetId.slice(0, slash) : r.targetId;
  const path = slash > 0 ? r.targetId.slice(slash + 1) : "";
  const name = curatedName ?? fallbackName(path, r.targetId);
  return { sourceId, path, name, rating: r.rating, body: r.body, createdAt: r.createdAt };
}

export async function buildProfile(db: AppDb, rawHandle: string): Promise<Profile | null> {
  const handle = rawHandle.trim();
  if (!HANDLE_RE.test(handle)) return null;   // reject junk before any query or URL build

  const accountId = await accountIdForHandle(db, handle);
  if (!accountId) return null;                // no handle, no profile — there is no other name

  // The canonical STORED casing, not the caller's input casing — accountIdForHandle resolves
  // case-insensitively (lower(handle) = lower($1)), so a `/@RayMond` URL must render the profile
  // under the handle as the user actually claimed it ("raymond"), not the visitor's spelling.
  const canonicalHandle = await handleForAccountId(db, accountId);
  if (!canonicalHandle) return null;          // handle vanished between resolve and read — no profile

  const acct = (await db
    .select({ id: accounts.id, login: accounts.login, avatarUrl: accounts.avatarUrl })
    .from(accounts).where(eq(accounts.id, accountId)).limit(1))[0];

  // `verified` follows the ACCOUNT, not the name. account_bindings.account_id is the PROVIDER's id
  // (text), so pair it with `provider` to reach the owning account. Matching account_login against
  // the handle would silently un-verify anyone who renamed, since the binding still holds their old
  // login. Resolved the same way accountIdForProvider does (Task 2): better-auth's `account` table
  // first — authoritative for every linked provider, unlike the legacy `accounts.provider`/
  // `provider_account_id` columns, which hold only the PRIMARY provider (Task 1) and would
  // otherwise never verify a Google-primary user who linked GitHub — falling back to the legacy
  // anchor for a binding whose `account` mirror write was skipped (best-effort; see binding.ts).
  const bind = (await db.execute(sql`
    select 1 from account_bindings ab
    where exists (select 1 from account a where a.provider_id = ab.provider and a.account_id = ab.account_id and a.user_id = ${accountId})
       or exists (select 1 from accounts leg where leg.provider = ab.provider and leg.provider_account_id = ab.account_id and leg.id = ${accountId})
    limit 1`));
  const verified = (bind.rows?.length ?? 0) > 0;

  // Ownership read: gems this ACCOUNT owns. Matching published_by would list impostor rows whose
  // string happens to equal the handle but whose owner_account_id is NULL or someone else's.
  const rows = await db
    .select({ gemKey: catalogGems.gemKey, version: catalogGems.version, description: catalogGems.description, grade: catalogGems.grade })
    .from(catalogGems)
    .where(eq(catalogGems.ownerAccountId, accountId))
    .orderBy(desc(catalogGems.createdAtMs), desc(catalogGems.version));
  const latest = new Map<string, { gemKey: string; version: string; description: string | null; grade: number | null }>();
  for (const r of rows) if (!latest.has(r.gemKey)) latest.set(r.gemKey, r);
  const base = [...latest.values()];

  const keys = base.map((g) => g.gemKey);
  const starMap = await starCounts(db, "gem", keys); // guards keys.length === 0 internally
  const adoptRows = keys.length ? await gemAdoption(db, { keys }) : []; // guard: empty keys → gemAdoption(true) would scan all gems
  const adopt = new Map(adoptRows.map((a) => [a.gemKey, a]));

  const gems: ProfileGem[] = base
    .map((g) => ({
      key: g.gemKey,
      version: g.version,
      description: g.description,
      grade: g.grade,
      stars: starMap[g.gemKey] ?? 0,
      installs: adopt.get(g.gemKey)?.installs ?? 0,
      verifiedInstalls: adopt.get(g.gemKey)?.verifiedInstalls ?? 0,
    }))
    .sort((a, b) => b.stars - a.stars || a.key.localeCompare(b.key));

  const totalStars = gems.reduce((s, g) => s + g.stars, 0);
  // Authored reviews (only accounts write them — a bind-only login with no accounts row has none).
  // Authored reviews (only accounts write them). Resolve each target's real display name from the
  // curated index (target id == `source_id || '/' || path`); fall back to the path for uncurated skills.
  let reviews: ProfileReview[] = [];
  if (acct) {
    const authored = await reviewsByAccount(db, acct.id, "skill");
    const nameMap = await skillNamesByTargetId(db, authored.map((r) => r.targetId));
    reviews = authored.map((r) => parseSkillReview(r, nameMap[r.targetId]));
  }
  // A GitHub URL is only meaningful when the account actually has a GitHub login — `accounts.login`
  // is set ONLY for github accounts (anchorAndScopes writes NULL for every other provider). A
  // login-less account (Google, etc.) has a handle that is a chosen name, NOT a GitHub username, so
  // `github.com/<handle>` would assert an identity the user never proved. null ⇒ the profile renders
  // the handle as plain text with no GitHub link.
  const githubUrl = acct?.login ? `https://github.com/${acct.login}` : null;
  return { login: canonicalHandle, avatarUrl: acct?.avatarUrl ?? null, verified, githubUrl, totalStars, gems, reviews };
}

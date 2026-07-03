// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Public profile assembly: one GitHub identity → avatar + verified flag + published gems with engagement.
// Reads catalog_gems.published_by (a plain login string, not a FK), so a profile renders even for a
// bind-only user with no accounts row — accounts only enriches it with an avatar. Decoupled from SP1.
import { sql, desc } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { accounts, accountBindings, catalogGems } from "./schema.js";
import { starCounts } from "./stars.js";
import { gemAdoption } from "./aggregates.js";

const LOGIN_RE = /^[A-Za-z0-9-]+$/; // GitHub login charset

export interface ProfileGem {
  key: string;
  version: string;
  description: string | null;
  grade: number | null;
  stars: number;
  installs: number;
  verifiedInstalls: number;
}
export interface Profile {
  login: string;
  avatarUrl: string | null;
  verified: boolean;
  githubUrl: string;
  totalStars: number;
  gems: ProfileGem[];
}

export async function buildProfile(db: AppDb, rawLogin: string): Promise<Profile | null> {
  const login = rawLogin.trim();
  if (!LOGIN_RE.test(login)) return null; // reject junk before any query or URL build

  const acct = (await db
    .select({ login: accounts.login, avatarUrl: accounts.avatarUrl })
    .from(accounts)
    .where(sql`lower(${accounts.login}) = lower(${login})`)
    .limit(1))[0];

  const bind = (await db
    .select({ pubkey: accountBindings.pubkey })
    .from(accountBindings)
    .where(sql`lower(${accountBindings.accountLogin}) = lower(${login})`)
    .limit(1))[0];
  const verified = !!bind;

  // All published rows for this author, newest first → dedupe to the latest version per gemKey.
  // Secondary sort on version keeps the pick deterministic when two versions share createdAtMs
  // (a stability tiebreaker, not semver ordering).
  const rows = await db
    .select({ gemKey: catalogGems.gemKey, version: catalogGems.version, description: catalogGems.description, grade: catalogGems.grade })
    .from(catalogGems)
    .where(sql`lower(${catalogGems.publishedBy}) = lower(${login})`)
    .orderBy(desc(catalogGems.createdAtMs), desc(catalogGems.version));
  const latest = new Map<string, { gemKey: string; version: string; description: string | null; grade: number | null }>();
  for (const r of rows) if (!latest.has(r.gemKey)) latest.set(r.gemKey, r);
  const base = [...latest.values()];

  if (!acct && base.length === 0 && !verified) return null;

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
  const canonical = acct?.login ?? login;
  return { login: canonical, avatarUrl: acct?.avatarUrl ?? null, verified, githubUrl: `https://github.com/${canonical}`, totalStars, gems };
}

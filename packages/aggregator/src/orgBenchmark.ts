// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Org-scoped benchmark aggregates: the org-filtered, no-k-anon analogue of the public
// modelBenchmark (aggregates.ts). Membership = the App-synced org_members roster joined to a
// producer's bound account_login. Admin-gated at the route; de-anonymized within the org.
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { effectivenessScore, type EffectivenessRow } from "./aggregates.js";

/** Producer-membership predicate: attestations whose producer's bound account_login is a
 *  member of `scope` (App-synced org_members roster). Shared by the org-scoped aggregates. */
const memberPubkeys = (scope: string) => sql`
  a.producer_pubkey in (
    select ab.pubkey from account_bindings ab
    join org_members om on lower(om.gh_login) = lower(ab.account_login)
    where lower(om.org_scope) = lower(${scope})
  )`;

export async function orgMemberLogins(db: AppDb, scope: string): Promise<string[]> {
  const r = await db.execute<{ login: string }>(sql`select lower(gh_login) as login from org_members where lower(org_scope) = lower(${scope})`);
  return (r.rows as { login: string }[]).map((x) => x.login);
}

/** Cross-model benchmark scoped to one org's members: same shape as modelBenchmark, but filtered
 *  to producers whose bound account is on the org's roster, and with NO k-anonymity floor — the
 *  admin viewing this is already inside the org's trust boundary, so a single-producer row is
 *  fine (contrast the public modelBenchmark's DEFAULT_K floor). */
export async function orgModelBenchmark(
  db: AppDb, scope: string,
): Promise<{ model: string; mostly: number; partially: number; notAchieved: number; producers: number; successRate: number }[]> {
  const r = await db.execute<{ model: string; mostly: number; partially: number; notAchieved: number; producers: number }>(sql`
    select mo.model,
           sum(mo.mostly)::int as mostly,
           sum(mo.partially)::int as partially,
           sum(mo.not_achieved)::int as "notAchieved",
           count(distinct a.producer_pubkey)::int as producers
    from model_outcomes mo
    join attestations a on a.id = mo.attestation_id and not a.quarantined
    where ${memberPubkeys(scope)}
    group by mo.model
    order by producers desc, mo.model
  `);
  return (r.rows as { model: string; mostly: number; partially: number; notAchieved: number; producers: number }[]).map((x) => {
    const denom = x.mostly + x.partially + x.notAchieved;
    return { ...x, successRate: denom > 0 ? x.mostly / denom : 0 };
  });
}

/** Per-gem effectiveness scoped to one org's members: same shape as `effectiveness`,
 *  reusing its pure `effectivenessScore` math, but filtered to the org's roster
 *  (via `memberPubkeys`) and with NO k-anonymity floor — same trust-boundary
 *  reasoning as `orgModelBenchmark`. Every row's producer is bound to a member
 *  account, so `verifiedProducers` is just `producers` here. */
export async function orgEffectiveness(db: AppDb, scope: string): Promise<EffectivenessRow[]> {
  const r = await db.execute<{ gemName: string; mostly: number; partially: number; notAchieved: number; producers: number }>(sql`
    select a.gem_name as "gemName",
           sum(mo.mostly)::int as mostly, sum(mo.partially)::int as partially, sum(mo.not_achieved)::int as "notAchieved",
           count(distinct a.producer_pubkey)::int as producers
    from model_outcomes mo
    join attestations a on a.id = mo.attestation_id and not a.quarantined
    where ${memberPubkeys(scope)}
    group by a.gem_name
  `);
  return (r.rows as { gemName: string; mostly: number; partially: number; notAchieved: number; producers: number }[])
    .map((row) => ({ ...row, verifiedProducers: row.producers, ...effectivenessScore(row) }))
    .sort((a, b) => b.score - a.score || b.producers - a.producers || a.gemName.localeCompare(b.gemName));
}

/** Per-member breakdown: one row per org member with a bound producer account that
 *  has produced at least one non-quarantined attestation, counting distinct
 *  attestations/gems and summing outcomes across all of them. */
export async function orgMemberBreakdown(
  db: AppDb, scope: string,
): Promise<{ login: string; attestations: number; gems: number; mostly: number; partially: number; notAchieved: number }[]> {
  const r = await db.execute<{ login: string; attestations: number; gems: number; mostly: number; partially: number; notAchieved: number }>(sql`
    select lower(ab.account_login) as login,
           count(distinct a.id)::int as attestations,
           count(distinct a.gem_name)::int as gems,
           coalesce(sum(mo.mostly),0)::int as mostly,
           coalesce(sum(mo.partially),0)::int as partially,
           coalesce(sum(mo.not_achieved),0)::int as "notAchieved"
    from attestations a
    join account_bindings ab on ab.pubkey = a.producer_pubkey
    join org_members om on lower(om.gh_login) = lower(ab.account_login) and lower(om.org_scope) = lower(${scope})
    left join model_outcomes mo on mo.attestation_id = a.id
    where not a.quarantined
    group by lower(ab.account_login)
    order by attestations desc, login
  `);
  return r.rows as { login: string; attestations: number; gems: number; mostly: number; partially: number; notAchieved: number }[];
}

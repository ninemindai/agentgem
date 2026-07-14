// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Org-scoped benchmark aggregates: the org-filtered, no-k-anon analogue of the public
// modelBenchmark (aggregates.ts). Membership = the App-synced org_members roster joined to a
// producer's bound account_login. Admin-gated at the route; de-anonymized within the org.
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";

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

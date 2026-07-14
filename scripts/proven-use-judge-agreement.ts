// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Validation instrument #2 (offline, run by hand): does the judge's
// `mostly_achieved` label track an INDEPENDENT signal it never saw? Ground truth
// here = "no rework" — a session's mission_hint did NOT recur in a strictly later
// session. If achieved sessions are re-attempted just as often as not-achieved
// ones, the label is a weak signal → drop ALPHA to 0 in recallIndex.ts until the
// judge improves. A MEASUREMENT, not a benchmark. Reads only artifact-outcomes.db.
//   pnpm tsx scripts/proven-use-judge-agreement.ts
import { DatabaseSync } from "node:sqlite";
import { defaultArtifactOutcomesDbPath, openArtifactOutcomesStore } from "@agentgem/insight";

// Ensure the file + schema exist (canonical opener) before the raw read below —
// on a machine that has never judged a session the table would otherwise be absent.
openArtifactOutcomesStore().close();
const db = new DatabaseSync(defaultArtifactOutcomesDbPath());
// outcome/mission_hint/at_ms are per-session (duplicated across a session's
// artifact rows); DISTINCT collapses to one row per judged session, oldest first.
const rows = db.prepare(
  `SELECT DISTINCT session_id, outcome, mission_hint, at_ms
     FROM artifact_outcomes
    WHERE mission_hint IS NOT NULL
    ORDER BY at_ms ASC`,
).all() as { session_id: string; outcome: string; mission_hint: string; at_ms: number }[];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
// 2x2: a=achieved&no-rework, b=achieved&rework, c=not&no-rework, d=not&rework
let a = 0, b = 0, c = 0, d = 0;
for (let i = 0; i < rows.length; i++) {
  const reworked = rows.some((o, j) => j > i && norm(o.mission_hint) === norm(rows[i].mission_hint));
  const achieved = rows[i].outcome === "mostly_achieved";
  if (achieved && !reworked) a++;
  else if (achieved && reworked) b++;
  else if (!achieved && !reworked) c++;
  else d++;
}
const phi = (a * d - b * c) / Math.sqrt(((a + b) * (c + d) * (a + c) * (b + d)) || 1);
console.log(`n=${rows.length} judged sessions`);
console.log(`               no-rework   rework`);
console.log(`achieved          ${a}         ${b}`);
console.log(`not-achieved      ${c}         ${d}`);
console.log(`phi(achieved ~ no-rework) = ${phi.toFixed(3)}   ( >0 supports the judge; ~0 = weak )`);
db.close();

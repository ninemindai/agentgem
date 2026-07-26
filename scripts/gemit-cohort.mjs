// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// scripts/gemit-cohort.mjs
//
// Regenerates the baked cohort table in src/gemit/cohort.ts from real published gemit
// cards. Reads composites from stdin — one integer 0..100 per line — so the source of
// those numbers stays an explicit, auditable step rather than a hidden network call.
//
//   node scripts/gemit-cohort.mjs < composites.txt
//
// Prints the COHORT literal. Paste it over the `export const COHORT` line. Refuses to
// emit anything below MIN_COHORT samples: a percentile from a small sample is noise.
//
// HAZARD before you paste this in: src/gemit/cohort.ts's topPercentFor() is unbounded.
// A real table turns a middling composite into "top 88%" rendered in a report published
// under the operator's own name — correct, but reads as sarcasm. Before this table ships,
// add a clamp in topPercentFor() (floor the displayed fraction, or suppress the claim
// below some percentile) that BOTH the card (themeRpg.ts) and the share text (share.ts)
// pick up together — see the comment on topPercentFor for why it can't be fixed on just
// one of those two call sites.

import { createInterface } from "node:readline";

// Must match src/gemit/cohort.ts MIN_COHORT. .mjs has no TS loader, so duplication
// is unavoidable; keep them synchronized.
const MIN_COHORT = 100;
const scores = [];

for await (const line of createInterface({ input: process.stdin })) {
  const trimmed = line.trim();
  // Only accept plain decimal integer literals 0-100: /^\d+$/ rejects blanks, hex (0x),
  // exponent (1e2), leading +/-, and non-numeric text.
  if (!/^\d+$/.test(trimmed)) continue;
  const n = Number(trimmed);
  if (n >= 0 && n <= 100) scores.push(n);
}

if (scores.length < MIN_COHORT) {
  console.error(`refusing: ${scores.length} samples, need >= ${MIN_COHORT}`);
  process.exit(1);
}

scores.sort((a, b) => a - b);
// p[i] = share of the cohort strictly below composite i, as a 0..99 integer.
const p = Array.from({ length: 101 }, (_, i) => {
  let below = 0;
  while (below < scores.length && scores[below] < i) below += 1;
  return Math.min(99, Math.round((100 * below) / scores.length));
});

const asOf = new Date().toISOString().slice(0, 10);
console.log(`export const COHORT: Cohort | null = {
  asOf: ${JSON.stringify(asOf)},
  n: ${scores.length},
  p: [${p.join(",")}],
};`);

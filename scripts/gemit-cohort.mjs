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

import { createInterface } from "node:readline";

const MIN_COHORT = 100;
const scores = [];

for await (const line of createInterface({ input: process.stdin })) {
  const n = Number(line.trim());
  if (Number.isInteger(n) && n >= 0 && n <= 100) scores.push(n);
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

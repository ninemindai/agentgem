// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/jsonReply.ts
//
// Agents wrap JSON. Asked for "ONLY a JSON object" they still return ```json fences,
// a lead-in sentence, or a sign-off — so every judge in this package has to find the
// object inside the prose before parsing it.
//
// This was duplicated verbatim in four modules (acpRecommender, discoverRerank,
// facets, narrateInsights) and MISSING from a fifth (criterionJudge), which is the
// expensive kind of duplication: the copies were fine, and the module without a copy
// silently degraded every live run — a fenced-but-perfect reply threw in JSON.parse,
// so the chunk was discarded and the criterion path never worked against a real agent.
// One implementation means the next judge cannot be born with the same hole.

/** The JSON object inside an agent reply, so fences and prose don't break JSON.parse.
 *  Returns the input unchanged when there is no object to find — the caller's own
 *  try/catch still owns what a genuinely unparseable reply means.
 *
 *  Fence FIRST, then the brace slice. Six copies of this existed; five used only the
 *  brace slice, which breaks on the common shape of a fenced object followed by a
 *  sign-off containing braces — `lastIndexOf("}")` then reaches past the JSON and
 *  swallows the prose. The fence, when present, is the more precise boundary. */
export function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

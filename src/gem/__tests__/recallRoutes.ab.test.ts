// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { abSearch } from "../../goldmine/recallRoutes.js";
import type { MomentHit, RecallFilters, ProvenUseLookup } from "@agentgem/recall";

const hit = (id: string, score: number): MomentHit =>
  ({ sessionId: id, agent: "claude", turn: 0, project: null, branch: null,
     startMs: 1, snippet: "", score, turnsMatched: 1 });

// A fake index: baseline order [A,B]; with a lookup it flips to [B,A].
const fakeIndex = {
  search(_q: string, _f: RecallFilters, _l: number, lookup?: ProvenUseLookup): MomentHit[] {
    return lookup ? [hit("B", 0.5), hit("A", 1)] : [hit("A", 1), hit("B", 0.5)];
  },
};
const lookup: ProvenUseLookup = { boostForSessions: (ids) => new Map(ids.map((i) => [i, 1])) };

describe("abSearch", () => {
  it("returns only baseline moments when ab is off", () => {
    const out = abSearch(fakeIndex, lookup, "q", {}, 10, false);
    expect(out.moments.map((m) => m.sessionId)).toEqual(["A", "B"]);
    expect(out.momentsBoosted).toBeUndefined();
  });

  it("returns both orderings when ab is on and a lookup exists", () => {
    const out = abSearch(fakeIndex, lookup, "q", {}, 10, true);
    expect(out.moments.map((m) => m.sessionId)).toEqual(["A", "B"]);       // baseline (no lookup)
    expect(out.momentsBoosted?.map((m) => m.sessionId)).toEqual(["B", "A"]); // boosted
  });

  it("omits the boosted arm when ab is on but no lookup is configured", () => {
    const out = abSearch(fakeIndex, undefined, "q", {}, 10, true);
    expect(out.moments.map((m) => m.sessionId)).toEqual(["A", "B"]);
    expect(out.momentsBoosted).toBeUndefined();
  });
});

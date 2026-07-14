// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallIndex, type ProvenUseLookup } from "../recallIndex.js";
import type { SessionMeta } from "../recallIndex.js";

const meta = (id: string): SessionMeta =>
  ({ sessionId: id, agent: "claude", project: "r", branch: "main", startMs: 1 });

// Two sessions with identical text ⇒ identical BM25; proven-use must break the tie.
function seed(index: RecallIndex) {
  index.upsertSession(meta("HI"), [{ turn: 0, text: "fix the aggregator schema bug" }], "a");
  index.upsertSession(meta("LO"), [{ turn: 0, text: "fix the aggregator schema bug" }], "b");
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "recall-pu-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("RecallIndex proven-use boost", () => {
  it("with no lookup, ordering is pure BM25 (kill switch = today's behavior)", () => {
    const index = new RecallIndex(join(dir, "i.db"));
    seed(index);
    const hits = index.search("aggregator schema", {}, 10);
    expect(hits.map((h) => h.sessionId).sort()).toEqual(["HI", "LO"]);
    index.close();
  });

  it("boosts the session with the higher proven-use (its own succeeded)", () => {
    const lookup: ProvenUseLookup = {
      boostForSessions: (ids) => new Map(ids.map((id) => [id, id === "HI" ? 1.0 : 0.0])),
    };
    const index = new RecallIndex(join(dir, "i2.db"));
    seed(index);
    const hits = index.search("aggregator schema", {}, 10, lookup);
    expect(hits[0].sessionId).toBe("HI"); // succeeded session wins the tie
    index.close();
  });

  it("G4: a lookup returning nothing (cold store) leaves order == pure BM25", () => {
    const cold: ProvenUseLookup = { boostForSessions: () => new Map() };
    const index = new RecallIndex(join(dir, "i3.db"));
    seed(index);
    const a = index.search("aggregator schema", {}, 10, cold).map((h) => h.sessionId).sort();
    const b = index.search("aggregator schema", {}, 10).map((h) => h.sessionId).sort();
    expect(a).toEqual(b);
    index.close();
  });
});

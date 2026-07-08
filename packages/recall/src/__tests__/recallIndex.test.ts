// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RecallIndex, HL_OPEN } from "../recallIndex.js";
import type { SessionMeta } from "../recallIndex.js";

let dir: string; let dbPath: string; let idx: RecallIndex;
const meta = (id: string, over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ sessionId: id, agent: "claude", project: "agentgem", branch: "main", startMs: 1000, ...over });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "recall-")); dbPath = join(dir, "i.db"); idx = new RecallIndex(dbPath); });
afterEach(() => { idx.close(); rmSync(dir, { recursive: true, force: true }); });

describe("RecallIndex", () => {
  it("ranks sessions by their best matching turn and rolls up matched-turn count", () => {
    idx.upsertSession(meta("s1"), [
      { turn: 0, text: "the prod database migration failed" },
      { turn: 3, text: "migration retried and the database recovered" },
    ], "a");
    idx.upsertSession(meta("s2", { project: "other" }), [{ turn: 1, text: "unrelated ui change" }], "b");
    const hits = idx.search("database migration", {}, 10);
    expect(hits.map((h) => h.sessionId)).toEqual(["s1"]);
    expect(hits[0].turnsMatched).toBe(2);
    expect(hits[0].turn).toBe(0); // best turn surfaced
    expect(hits[0].snippet).toContain(HL_OPEN); // highlighted
  });

  it("applies project / agent / since filters", () => {
    idx.upsertSession(meta("s1", { project: "agentgem", startMs: 5000 }), [{ turn: 0, text: "schema drift bug" }], "a");
    idx.upsertSession(meta("s2", { project: "goose", startMs: 5000 }), [{ turn: 0, text: "schema drift bug" }], "b");
    expect(idx.search("schema", { project: "goose" }, 10).map((h) => h.sessionId)).toEqual(["s2"]);
    expect(idx.search("schema", { since: 9000 }, 10)).toHaveLength(0);
  });

  it("upsert replaces a session's chunks and tracks its stamp", () => {
    idx.upsertSession(meta("s1"), [{ turn: 0, text: "first version alpha" }], "v1");
    idx.upsertSession(meta("s1"), [{ turn: 0, text: "second version beta" }], "v2");
    expect(idx.search("alpha", {}, 10)).toHaveLength(0);
    expect(idx.search("beta", {}, 10)).toHaveLength(1);
    expect(idx.indexedSessions().get("claude:s1")).toBe("v2");
  });

  it("deleteSession removes a session's rows", () => {
    idx.upsertSession(meta("s1"), [{ turn: 0, text: "deletable content" }], "a");
    idx.deleteSession("claude", "s1");
    expect(idx.search("deletable", {}, 10)).toHaveLength(0);
    expect(idx.indexedSessions().has("claude:s1")).toBe(false);
  });

  it("rebuilds when the on-disk schema version is stale", () => {
    idx.upsertSession(meta("s1"), [{ turn: 0, text: "surviving content" }], "a");
    idx.close();
    // Corrupt the stored version, reopen — index must self-wipe, not crash.
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE meta SET v = ? WHERE k = 'schema'").run("0");
    raw.close();
    const reopened = new RecallIndex(dbPath);
    expect(reopened.search("surviving", {}, 10)).toHaveLength(0);
    expect(reopened.indexedSessions().size).toBe(0);
    reopened.close();
  });

  it("clear empties the index", () => {
    idx.upsertSession(meta("s1"), [{ turn: 0, text: "wipe me" }], "a");
    idx.clear();
    expect(idx.search("wipe", {}, 10)).toHaveLength(0);
  });

  it("facets returns the sorted distinct projects and agents", () => {
    idx.upsertSession(meta("s1", { agent: "claude", project: "goose" }), [{ turn: 0, text: "first" }], "a");
    idx.upsertSession(meta("s2", { agent: "codex", project: "agentgem" }), [{ turn: 0, text: "second" }], "b");
    expect(idx.facets()).toEqual({ projects: ["agentgem", "goose"], agents: ["claude", "codex"] });
  });
});

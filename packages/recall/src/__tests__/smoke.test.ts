// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";

describe("recall package", () => {
  it("has a working node:sqlite with FTS5", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
    db.prepare("INSERT INTO t(rowid, x) VALUES (1, ?)").run("hello world");
    const row = db.prepare("SELECT rowid FROM t WHERE t MATCH ?").get("hello") as { rowid: number };
    expect(row.rowid).toBe(1);
    db.close();
  });
});

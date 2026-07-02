import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scanCursorSessions } from "@agentgem/insight";

function makeDb(dir: string): string {
  const path = join(dir, "state.vscdb");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  // one composer with 2 bubbles (1 user, 1 assistant). value is a JSON STRING (double-encode).
  put.run("composerData:c1", JSON.stringify({ composerId: "c1", _v: 3, fullConversationHeadersOnly: [ { bubbleId: "b1", type: 1 }, { bubbleId: "b2", type: 2 } ] }));
  put.run("bubbleId:c1:b1", JSON.stringify({ type: 1, createdAt: 1751328000000, text: "SECRET user text" }));
  put.run("bubbleId:c1:b2", JSON.stringify({ type: 2, createdAt: 1751328600000, text: "SECRET reply", inputTokens: 100, outputTokens: 40, tokenCount: 140, model: "claude-sonnet-5" }));
  db.close();
  return path;
}

describe("Cursor SQLite scan", () => {
  it("aggregates a composer + bubbles into a SessionStat; never reads bubble text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-"));
    const dbPath = makeDb(dir);
    const stats = await scanCursorSessions(dbPath);
    expect(stats).toHaveLength(1);
    const s = stats[0];
    expect(s).toMatchObject({ agent: "cursor", sessionId: "c1", msgs: 2 });
    expect(s.tokensIn).toBe(100);
    expect(s.tokensOut).toBe(40);
    expect(s.startMs).toBe(1751328000000);
    expect(s.endMs).toBe(1751328600000);
    expect(JSON.stringify(s)).not.toContain("SECRET"); // privacy: no bubble text in the stat
  });
  it("returns [] for a missing DB, never throws", async () => {
    await expect(scanCursorSessions("/no/such/state.vscdb")).resolves.toEqual([]);
  });
});

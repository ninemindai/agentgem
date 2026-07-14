import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallIndex } from "@agentgem/recall";
import { pullIntoRecall } from "../pull.js";
import { readCursor } from "../cursors.js";
import type { MemoryProvider, MemoryRecord } from "../types.js";

let home: string;
let index: RecallIndex;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agm-pull-"));
  process.env.AGENTGEM_HOME = home;
  index = new RecallIndex(join(home, "recall.db"));
});
afterEach(() => { index.close(); delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); });

function fakeProvider(records: MemoryRecord[]): MemoryProvider {
  return {
    id: "mem0",
    async test() { return { ok: true }; },
    async *pull(_cfg, since) { for (const r of records) if (since === undefined || r.updatedAt > since) yield r; },
    async push() { return { id: "x" }; },
  };
}

describe("pullIntoRecall", () => {
  it("maps memories to searchable recall rows under memory:mem0 and advances the cursor", async () => {
    const provider = fakeProvider([
      { id: "m1", text: "raymond prefers pnpm workspaces", updatedAt: 1000 },
      { id: "m2", text: "the recall index uses node sqlite", updatedAt: 2000 },
    ]);
    const res = await pullIntoRecall(provider, { enabled: true, apiKey: "k", userId: "u" }, index);
    expect(res.pulled).toBe(2);

    const hits = index.search("pnpm", { agent: "memory:mem0" }, 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(readCursor("mem0")).toBe(2000);
  });

  it("upserts by provider id (no duplicate rows on re-pull)", async () => {
    const provider = fakeProvider([{ id: "m1", text: "alpha beta gamma", updatedAt: 1000 }]);
    await pullIntoRecall(provider, { enabled: true, apiKey: "k" }, index);
    // second pull ignores cursor for this assertion by resetting records with a newer stamp
    const provider2 = fakeProvider([{ id: "m1", text: "alpha beta gamma delta", updatedAt: 3000 }]);
    await pullIntoRecall(provider2, { enabled: true, apiKey: "k" }, index);
    const hits = index.search("alpha", { agent: "memory:mem0" }, 10);
    expect(hits).toHaveLength(1);
  });
});

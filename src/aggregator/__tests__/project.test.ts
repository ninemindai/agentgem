// src/aggregator/__tests__/project.test.ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db.js";
import { projectAttestation } from "../project.js";

function att(pubkey: string, gemDigest: string) {
  return {
    formatVersion: 1, canonicalizerVersion: 3,
    gem: { name: "g", digest: gemDigest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: ["claude-opus-4-8"], scan: { sessions: 4, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: {
      skills: [
        { id: "skill:superpowers@m/brainstorming", idKind: "plugin", public: true, invocations: 9, sessions: 3 },
        { id: "private:sha256:xyz", idKind: "private", public: false, invocations: 1, sessions: 1 },
      ],
      mcps: [{ id: "mcp:context7@m/context7", idKind: "plugin", public: true, invocations: 15, sessions: 4 }],
    },
    evidence: { signalDigest: "sha256:d" }, signedAt: 1, signature: "x",
  };
}

describe("projectAttestation", () => {
  it("writes public ingredients (+ harness + models) as edges and counts private", async () => {
    const db = await createDb();
    const r = await projectAttestation(db, att("ed25519:p1", "sha256:1") as never);
    expect(r.privateCount).toBe(1);
    // public ingredients: harness + 1 model + 1 skill + 1 mcp = 4
    expect(r.publicIngredients).toBe(4);
    const ids = (await db.query<{ id: string }>("select id from ingredients order by id")).rows.map((x) => x.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("skill:superpowers@m/brainstorming");
    expect(ids).toContain("mcp:context7@m/context7");
    expect(ids).not.toContain("private:sha256:xyz"); // private never becomes a row
    const edge = (await db.query<{ invocations: number; sessions: number }>(
      "select invocations, sessions from usage_edges e join ingredients i on i.id=e.ingredient_id where i.id='mcp:context7@m/context7'")).rows[0];
    expect(edge).toEqual({ invocations: 15, sessions: 4 });
    const pc = (await db.query<{ private_count: number }>("select private_count from attestations")).rows[0];
    expect(pc.private_count).toBe(1);
    const harnessEdge = (await db.query<{ invocations: number; sessions: number }>(
      "select e.invocations, e.sessions from usage_edges e where e.ingredient_id = 'claude-code'")).rows[0];
    expect(harnessEdge).toEqual({ invocations: 4, sessions: 4 });
    const modelEdge = (await db.query<{ invocations: number; sessions: number }>(
      "select e.invocations, e.sessions from usage_edges e where e.ingredient_id = 'claude-opus-4-8'")).rows[0];
    expect(modelEdge).toEqual({ invocations: 4, sessions: 4 });
    const ac = (await db.query<{ attest_count: number }>("select attest_count from producers")).rows[0];
    expect(ac.attest_count).toBe(1);
  });
});

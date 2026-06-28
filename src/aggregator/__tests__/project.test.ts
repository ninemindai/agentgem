// src/aggregator/__tests__/project.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../testDb.js";
import { projectAttestation } from "../project.js";
import { ingredients, usageEdges, attestations, producers } from "../schema.js";

function att(pubkey: string, gemDigest: string) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest: gemDigest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: ["claude-opus-4-8"], scan: { sessions: 4, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: {
      skills: [
        { id: "skill:superpowers@m/brainstorming", idKind: "plugin", public: true, invocations: 9, sessions: 3 },
        { id: "private:sha256:xyz", idKind: "private", public: false, invocations: 1, sessions: 1 },
      ],
      mcps: [{ id: "mcp:context7@m/context7", idKind: "plugin", public: true, invocations: 15, sessions: 4 }],
    },
    evidence: { signalDigest: "sha256:d" }, signedAt: 1, signature: "x" } as never;
}

describe("projectAttestation (drizzle)", () => {
  it("writes public ingredients (+harness+models) and counts private", async () => {
    const db = await makeTestDb();
    const r = await projectAttestation(db, att("ed25519:p1", "sha256:1"));
    expect(r).toMatchObject({ privateCount: 1, publicIngredients: 4 }); // harness + 1 model + 1 skill + 1 mcp
    const ids = (await db.select({ id: ingredients.id }).from(ingredients)).map((x) => x.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("skill:superpowers@m/brainstorming");
    expect(ids).toContain("mcp:context7@m/context7");
    expect(ids).not.toContain("private:sha256:xyz");
    const edge = (await db.execute(sql`select invocations, sessions from usage_edges where ingredient_id='mcp:context7@m/context7'`)).rows[0];
    expect(edge).toEqual({ invocations: 15, sessions: 4 });
    const harnessEdge = (await db.execute(sql`select invocations, sessions from usage_edges where ingredient_id='claude-code'`)).rows[0];
    expect(harnessEdge).toEqual({ invocations: 4, sessions: 4 }); // scan.sessions proxy
    const modelEdge = (await db.execute(sql`select invocations, sessions from usage_edges where ingredient_id='claude-opus-4-8'`)).rows[0];
    expect(modelEdge).toEqual({ invocations: 4, sessions: 4 }); // model edge also = scan.sessions proxy
    const a = (await db.select().from(attestations))[0];
    expect(a.privateCount).toBe(1);
    const p = (await db.select().from(producers))[0];
    expect(p.attestCount).toBe(1);
  });
});

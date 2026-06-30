import { describe, it, expect } from "vitest";
import { makeTestDb } from "@agentgem/aggregator";
import { createShareCard, getShareCard } from "../shareStore.js";

describe("shareStore gem", () => {
  it("creates + reads a gem record", async () => {
    const db = await makeTestDb();
    const { id, url } = await createShareCard(db, { kind: "gem", name: "wf", provenance: "Distilled from 5 sessions", generatedAtMs: 5 });
    expect(url).toBe(`https://agentgem.ai/share/${id}`);
    const rec = await getShareCard(db, id);
    expect(rec).toMatchObject({ kind: "gem", name: "wf", provenance: "Distilled from 5 sessions" });
  });
  it("still creates + reads a certificate record", async () => {
    const db = await makeTestDb();
    const { id } = await createShareCard(db, { kind: "certificate", counts: { breadth: 1, battleTested: 1, portable: 1 }, generatedAtMs: 5 });
    expect((await getShareCard(db, id))!.kind).toBe("certificate");
  });
});

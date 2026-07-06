// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// End-to-end: a shared setup is published, becomes installable with preview artifacts, is downloaded
// and verified, materializes into the Claude target, and gates its executable artifacts — all with
// NO registry configured (pure aggregator DB), which is the whole point of the hosted-store model.
import { describe, it, expect } from "vitest";
import { makeTestDb, producers, accountBindings, listCatalogGems } from "@agentgem/aggregator";
import { importGem } from "@agentgem/distribute";
import { materialize } from "@agentgem/model";
import { AggregatorController } from "../../aggregator.controller.js";
import { executableArtifacts, hasExecutable } from "../hostedInstall.js";
import { signer, sampleGem, signedPublishBody } from "../../aggregator/__tests__/helpers/publishFixtures.js";

describe("share → preview → zero-config install (e2e)", () => {
  it("publishes, exposes installable+artifacts, downloads+verifies+materializes, gates executables", async () => {
    const db = await makeTestDb();
    const s = signer();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
    const c = new AggregatorController(db);

    // 1) Publish the setup (archive + signed manifest).
    const body = signedPublishBody(sampleGem(), s, { gemKey: "@octocat/my-setup", version: "1.0.0", signedAt: Date.now() });
    expect(await c.publishGem({ body })).toMatchObject({ shared: true, publishedBy: "octocat" });

    // 2) Browse: the gem is installable and carries the per-artifact preview list.
    const row = (await listCatalogGems(db))[0];
    expect(row.installable).toBe(true);
    expect(row.artifacts?.map((a) => a.type)).toEqual(["skill", "instructions", "mcp_server", "hook"]);

    // 3) Download the archive (what a consumer's console pulls, zero-config).
    const dl = await c.gemArchive({ query: { key: "@octocat/my-setup", version: "1.0.0" } });
    const bytes = Buffer.from(dl.archiveBase64, "base64");

    // 4) Verify (importGem checks gem.lock) and surface the executables that drive consent.
    const { gem } = importGem(bytes);
    expect(hasExecutable(gem)).toBe(true);
    expect(executableArtifacts(gem)).toEqual({ mcp: ["gh"], hooks: ["fmt"] });

    // 5) Materialize into the Claude target — all four kinds land (Claude supports them all).
    const mat = materialize(gem, "claude");
    expect(mat.skipped).toEqual([]);
    expect(Object.keys(mat.files).length).toBeGreaterThanOrEqual(4);
  });

  it("a text-only gem needs no consent and still materializes", async () => {
    const db = await makeTestDb();
    const s = signer();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "9", accountLogin: "octocat" });
    const c = new AggregatorController(db);
    const textGem = { name: "notes", createdFrom: "/x", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "s", source: "standalone", content: "# S" } as const, { type: "instructions", name: "i", content: "guide" } as const] };
    const body = signedPublishBody(textGem, s, { gemKey: "@octocat/notes", version: "1.0.0", signedAt: Date.now() });
    await c.publishGem({ body });
    const dl = await c.gemArchive({ query: { key: "@octocat/notes", version: "1.0.0" } });
    const { gem } = importGem(Buffer.from(dl.archiveBase64, "base64"));
    expect(hasExecutable(gem)).toBe(false);
    expect(materialize(gem, "claude").skipped).toEqual([]);
  });
});

// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb } from "@agentgem/aggregator";
import { ShareController } from "../share.controller.js";

// Regression: a gem name that is only whitespace/control chars passes the framework's
// JSON-Schema minLength:1 (it counts the raw chars) but the handler's `.transform(sanitize)`
// trims it to "" and fails `.min(1)`, throwing a raw ZodError → 500. The handler must instead
// surface a clean 4xx for a body its own advertised schema accepted.
describe("ShareController.create", () => {
  it("returns a 422 (not a 500) when the gem name sanitizes to empty", async () => {
    const db = await makeTestDb();
    const c = new ShareController(db);
    await expect(
      c.create({ body: { kind: "gem", name: "   ", provenance: "x", generatedAtMs: 1 } }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("mints a sanitized share for a valid gem name", async () => {
    const db = await makeTestDb();
    const c = new ShareController(db);
    const res = await c.create({ body: { kind: "gem", name: "  my-gem  ", provenance: "p", generatedAtMs: 1 } });
    expect(res.id).toHaveLength(10);
    expect(res.url).toContain("/share/");
  });

  it("mints a certificate share", async () => {
    const db = await makeTestDb();
    const c = new ShareController(db);
    const res = await c.create({ body: { kind: "certificate", counts: { breadth: 5, battleTested: 2, portable: 1 }, generatedAtMs: 1 } });
    expect(res.url).toContain("/share/");
  });
});

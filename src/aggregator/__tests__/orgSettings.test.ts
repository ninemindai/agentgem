// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, patchOrgSettings, putOrgSettings, getOrgSettings } from "@agentgem/aggregator";

describe("patchOrgSettings", () => {
  it("applies a partial patch, leaving unspecified fields untouched", async () => {
    const db = await makeTestDb();
    await patchOrgSettings(db, "acme", { retentionDays: 30, dashboardEnabled: true }, "init");
    await patchOrgSettings(db, "acme", { dashboardEnabled: false }, "editor"); // only the flag
    const s = await getOrgSettings(db, "acme");
    expect(s.retentionDays).toBe(30);        // untouched
    expect(s.dashboardEnabled).toBe(false);  // changed
    expect(s.updatedBy).toBe("editor");
  });

  it("preserves both concurrent partial updates (no lost write)", async () => {
    const db = await makeTestDb();
    await patchOrgSettings(db, "acme", { retentionDays: 30, dashboardEnabled: true }, "init");
    // Two admins editing DIFFERENT fields at once. The old get→merge→put across two statements lost
    // one change; the atomic patch keeps both.
    await Promise.all([
      patchOrgSettings(db, "acme", { retentionDays: 60 }, "a"),
      patchOrgSettings(db, "acme", { dashboardEnabled: false }, "b"),
    ]);
    const s = await getOrgSettings(db, "acme");
    expect(s.retentionDays).toBe(60);
    expect(s.dashboardEnabled).toBe(false);
  });

  it("the old non-atomic get→merge→put pattern DOES lose a concurrent change (characterizes the bug)", async () => {
    const db = await makeTestDb();
    await putOrgSettings(db, "acme", { retentionDays: 30, dashboardEnabled: true }, "init");
    const rmw = async (patch: { retentionDays?: number | null; dashboardEnabled?: boolean }) => {
      const cur = await getOrgSettings(db, "acme");
      await putOrgSettings(db, "acme", {
        retentionDays: "retentionDays" in patch ? patch.retentionDays! : cur.retentionDays,
        dashboardEnabled: "dashboardEnabled" in patch ? patch.dashboardEnabled! : cur.dashboardEnabled,
      }, "x");
    };
    await Promise.all([rmw({ retentionDays: 60 }), rmw({ dashboardEnabled: false })]);
    const s = await getOrgSettings(db, "acme");
    expect(s.retentionDays === 60 && s.dashboardEnabled === false).toBe(false); // one write was lost
  });
});

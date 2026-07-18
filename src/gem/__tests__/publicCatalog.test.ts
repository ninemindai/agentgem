// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mapDbToGems } from "../publicCatalog.js";
import type { CatalogRow } from "@agentgem/contract";

describe("mapDbToGems", () => {
  it("maps an installable DB row with its artifacts through to the browse gem", () => {
    const rows: CatalogRow[] = [{ gemKey: "@me/setup", version: "1.0.0", publishedBy: "me", createdAtMs: 1, installable: true, artifacts: [{ name: "s", type: "skill" }, { name: "h", type: "hook" }] }];
    const [g] = mapDbToGems(rows);
    expect(g).toMatchObject({ key: "@me/setup", installable: true, artifacts: [{ name: "s", type: "skill" }, { name: "h", type: "hook" }] });
  });
  it("a DB row without an archive is not installable and has no artifacts", () => {
    const [g] = mapDbToGems([{ gemKey: "@me/x", version: "1.0.0", publishedBy: "me", createdAtMs: 1, installable: false }]);
    expect(g.installable).toBe(false);
    expect(g.artifacts).toBeUndefined();
  });
});

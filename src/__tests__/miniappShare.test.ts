// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankStudio, readMiniappShare, writeMiniappShare, clearMiniappShare } from "@agentgem/play";

beforeEach(() => { process.env.AGENTGEM_HOME = mkdtempSync(join(tmpdir(), "share-")); });

describe("miniapp share sidecar", () => {
  it("round-trips a share record and clears it", async () => {
    const { name } = await blankStudio("My Game", "build me a game");
    expect(readMiniappShare(name)).toBeNull();
    writeMiniappShare(name, { shareId: "xK3f9a2Bq1", url: "https://app.agentgem.ai/games/xK3f9a2Bq1", sharedAtMs: 1 });
    expect(readMiniappShare(name)).toEqual({ shareId: "xK3f9a2Bq1", url: "https://app.agentgem.ai/games/xK3f9a2Bq1", sharedAtMs: 1 });
    clearMiniappShare(name);
    expect(readMiniappShare(name)).toBeNull();
  });

  it("returns null for a miniapp that was never shared", async () => {
    const { name } = await blankStudio("Other", "x");
    expect(readMiniappShare(name)).toBeNull();
  });
});

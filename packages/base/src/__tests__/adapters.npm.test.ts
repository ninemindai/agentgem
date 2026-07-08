// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { npmAdapterInstaller } from "../adapters.js";

describe("npmAdapterInstaller", () => {
  it("invokes npm install with the pinned version and --prefix", async () => {
    const spawnFn = vi.fn(async () => ({ code: 0, stderr: "" }));
    await npmAdapterInstaller(spawnFn)("@agentclientprotocol/codex-acp", "1.1.0", "/tmp/x.installing");
    expect(spawnFn).toHaveBeenCalledWith(
      "npm",
      ["install", "@agentclientprotocol/codex-acp@1.1.0", "--prefix", "/tmp/x.installing", "--no-audit", "--no-fund", "--loglevel=error"],
    );
  });

  it("rejects with the stderr tail on non-zero exit", async () => {
    const spawnFn = vi.fn(async () => ({ code: 1, stderr: "E404 not found" }));
    await expect(npmAdapterInstaller(spawnFn)("p", "1.0.0", "/tmp/x"))
      .rejects.toThrow(/E404 not found/);
  });
});

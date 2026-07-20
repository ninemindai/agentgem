// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WARMABLES } from "@agentgem/app/warm/registry";

const origHome = process.env.AGENTGEM_HOME;
const origToggle = process.env.AGENTGEM_BENCHMARK_CONTRIBUTE;
afterEach(() => {
  if (origHome === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = origHome;
  if (origToggle === undefined) delete process.env.AGENTGEM_BENCHMARK_CONTRIBUTE; else process.env.AGENTGEM_BENCHMARK_CONTRIBUTE = origToggle;
});

function contribute() { return WARMABLES.find((w) => w.id === "contribute")!; }

describe("contribute warmable", () => {
  it("is registered as cheap and global", () => {
    expect(contribute().cost).toBe("cheap");
    expect(contribute().scope).toBe("global");
  });

  // The required case per the task brief: toggle OFF (no config file, env unset) means
  // warm() must short-circuit on benchmarkContribute() before touching the corpus scan
  // or posting anything — so this never hits fs beyond the isolated temp home or the
  // network. The "on" path (contribute() actually running) needs mocked network deps
  // and is left to contributeCore's own tests, not exercised here.
  it("returns 'hit' without contributing when the toggle is off", async () => {
    const home = mkdtempSync(join(tmpdir(), "reg-contribute-"));
    process.env.AGENTGEM_HOME = home;
    delete process.env.AGENTGEM_BENCHMARK_CONTRIBUTE;
    try {
      await expect(contribute().warm(null, {})).resolves.toBe("hit");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

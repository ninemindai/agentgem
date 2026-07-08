// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/__tests__/installAgentWiring.test.ts
import { describe, it, expect, vi } from "vitest";
import { installAgentFn } from "../chatRoutes.js";
import { adapterRuntimeCtx } from "@agentgem/base";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterCtx } from "@agentgem/base";

const ctx: AdapterCtx = { runtime: "cli", execPath: "/usr/bin/node", home: "/home/u", onPath: () => false, exists: () => false, readJson: () => ({}) };

describe("installAgentFn", () => {
  it("throws 'unknown agent' for an id not in the registry", async () => {
    await expect(installAgentFn(ctx, vi.fn())("nope", true)).rejects.toThrow(/unknown agent/i);
  });
  it("maps the ensure result and attaches needsLogin after a real install into a temp home", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentgem-wiring-"));
    // Real fs + real readJson, but force onPath=false so resolution can't short-circuit to a
    // globally-installed codex-acp on this machine — we want the managed-dir install path.
    const tempCtx = adapterRuntimeCtx({ home, runtime: "cli", onPath: () => false });
    const install = async (_pkg: string, _v: string, destPrefix: string) => {
      const pkgDir = join(destPrefix, "node_modules", "@agentclientprotocol", "codex-acp");
      mkdirSync(join(pkgDir, "dist"), { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ bin: { "codex-acp": "dist/index.js" } }));
      writeFileSync(join(pkgDir, "dist", "index.js"), "// stub adapter entry");
    };
    const out = await installAgentFn(tempCtx, install)("codex", true);
    expect(out).toEqual({ available: true, source: "managed", needsLogin: true });
  });
});

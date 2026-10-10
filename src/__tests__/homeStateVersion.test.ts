// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// home-state.json's firstSeenVersion read `../../package.json` relative to the module.
// That path only fit the loose tsc layout, where it found @agentgem/app's own version
// rather than the product's. Inlined into the npm bin (dist/client.js) or the desktop
// core bundle (resources/core/index.mjs), it pointed above the package and recorded
// "0.0.0". Each layout below is the real one, rebuilt in a temp dir.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productVersion } from "@agentgem/app/home/state";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pv-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function pkg(dir: string, body: object): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(body));
  return dir;
}

describe("productVersion", () => {
  it("npm install: the bundled bin in dist/ finds the package root", () => {
    const pkgRoot = pkg(join(root, "node_modules", "@ninemind", "agentgem"), { name: "@ninemind/agentgem", version: "0.12.1" });
    mkdirSync(join(pkgRoot, "dist"));
    expect(productVersion(join(pkgRoot, "dist"))).toBe("0.12.1");
  });

  it("desktop: the core bundle reads the agentgem-core manifest beside it", () => {
    const core = pkg(join(root, "AgentGem.app", "Contents", "Resources", "core"), { name: "agentgem-core", version: "0.12.1" });
    expect(productVersion(core)).toBe("0.12.1");
  });

  it("workspace: skips @agentgem/app's own manifest and finds the repo root", () => {
    pkg(root, { name: "@ninemind/agentgem", version: "0.12.1" });
    pkg(join(root, "packages", "app"), { name: "@agentgem/app", version: "0.7.0" });
    const moduleDir = join(root, "packages", "app", "dist", "home");
    mkdirSync(moduleDir, { recursive: true });
    expect(productVersion(moduleDir)).toBe("0.12.1");
  });

  it("no product manifest anywhere above: 0.0.0", () => {
    const dir = join(root, "a", "b");
    mkdirSync(dir, { recursive: true });
    expect(productVersion(dir)).toBe("0.0.0");
  });
});

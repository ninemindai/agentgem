// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWorkerPath, WORKER_CANDIDATES } from "@agentgem/app/warm/workerPath";

// bundle-bins.mjs inlines warm/registry.js into dist/index.js, which rewrites
// import.meta.url from dist/warm/ to dist/. A single relative candidate resolves in
// exactly one of those layouts, so the worker must be found in BOTH.
describe("resolveWorkerPath", () => {
  it("finds the worker in the loose tsc layout (caller at dist/warm/registry.js)", () => {
    const root = mkdtempSync(join(tmpdir(), "wp-loose-"));
    try {
      mkdirSync(join(root, "warm"), { recursive: true });
      writeFileSync(join(root, "warm", "scorecardWorker.js"), "");
      const base = pathToFileURL(join(root, "warm", "registry.js")).href;
      expect(resolveWorkerPath(base)).toBe(join(root, "warm", "scorecardWorker.js"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("finds the worker in the bundled layout (caller inlined into dist/index.js)", () => {
    const root = mkdtempSync(join(tmpdir(), "wp-bundled-"));
    try {
      mkdirSync(join(root, "warm"), { recursive: true });
      writeFileSync(join(root, "warm", "scorecardWorker.js"), "");
      const base = pathToFileURL(join(root, "index.js")).href; // esbuild rewrote import.meta.url to here
      expect(resolveWorkerPath(base)).toBe(join(root, "warm", "scorecardWorker.js"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("returns null when no layout has the worker, so the caller can run inline", () => {
    const root = mkdtempSync(join(tmpdir(), "wp-none-"));
    try {
      expect(resolveWorkerPath(pathToFileURL(join(root, "index.js")).href)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("probes the loose layout before the bundled one", () => {
    expect([...WORKER_CANDIDATES]).toEqual(["./scorecardWorker.js", "./warm/scorecardWorker.js"]);
  });

  // The worker is only self-contained if the bundler emits it as its own entrypoint;
  // otherwise it ships with bare @agentgem/* imports and dies on a consumer's install.
  it("is registered as a bundle-bins entrypoint", () => {
    const src = readFileSync(new URL("../../../scripts/bundle-bins.mjs", import.meta.url), "utf8");
    expect(src).toContain("warm/scorecardWorker.js");
  });
});

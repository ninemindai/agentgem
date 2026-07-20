// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/app/src/__tests__/workerBundleInput.test.ts
//
// Guards the worker-publish contract that both bundlers depend on. scripts/bundle-bins.mjs (OSS
// CLI) and enterprise/scripts/bundle-server.mjs each read the Worker() entrypoints from
// packages/app/dist and throw `missing entrypoint` if they aren't there — a failure that only
// surfaces at publish/deploy time, never in the normal test run. When the workers moved into this
// package (the @agentgem/app extraction) both bundlers had to be repointed at packages/app/dist;
// this test fails loudly if a future move breaks that input path again, and confirms the runtime
// probe (resolveWorkerPath) still resolves them at the compiled layout.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { resolveWorkerPath } from "../warm/workerPath.js";

// This test compiles to packages/app/dist/__tests__/, so `..` is packages/app/dist — exactly the
// `appDist` both bundlers join their worker paths against.
const appDist = dirname(dirname(fileURLToPath(import.meta.url)));

describe("worker bundle-input contract", () => {
  it("compiles the Worker() entrypoints where both bundlers read them", () => {
    // Mirrors the `join(appDist, ...)` entries in bundle-bins.mjs and bundle-server.mjs.
    expect(existsSync(join(appDist, "warm", "scorecardWorker.js"))).toBe(true);
    expect(existsSync(join(appDist, "transcriptParseWorker.js"))).toBe(true);
  });

  it("resolveWorkerPath finds the scorecard worker from the warm/ caller layout", () => {
    // The real caller (warm/registry) lives in packages/app/dist/warm/; resolveWorkerPath probes
    // relative to its module URL. `./warm/scorecardWorker.js` is the loose-layout candidate.
    const warmDirUrl = pathToFileURL(join(appDist, "warm") + "/").href;
    const resolved = resolveWorkerPath(warmDirUrl, ["./scorecardWorker.js"]);
    expect(resolved).toBe(join(appDist, "warm", "scorecardWorker.js"));
  });

  it("returns null when no candidate exists on disk (run-inline fallback)", () => {
    const resolved = resolveWorkerPath(pathToFileURL(join(appDist, "warm") + "/").href, ["./nope.js"]);
    expect(resolved).toBeNull();
  });
});

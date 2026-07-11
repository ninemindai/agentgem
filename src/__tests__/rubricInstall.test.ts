// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinRubrics, loadRubrics, rubricToArtifact } from "@agentgem/insight";
import { exportGem, importGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";
import { installRubricGem } from "../rubricCore.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "rubric-install-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function gemWith(name: string): Gem {
  const r = builtinRubrics().find((x) => x.id === "context-hygiene")!;
  return { name, createdFrom: "test", artifacts: [{ ...rubricToArtifact(r), name }], checks: [], requiredSecrets: [] };
}

describe("installRubricGem", () => {
  it("installs rubric artifacts into the store so loadRubrics lists them", () => {
    const dir = tmp();
    const res = installRubricGem(gemWith("team-hygiene"), dir);
    expect(res.installed).toEqual(["team-hygiene"]);
    expect(loadRubrics(dir).map((r) => r.id)).toContain("team-hygiene");
  });

  it("refuses to overwrite a built-in id", () => {
    const dir = tmp();
    const res = installRubricGem(gemWith("hygiene"), dir);
    expect(res.installed).toEqual([]);
    expect(res.skipped).toEqual(["hygiene"]);
  });

  it("survives a full export -> import -> install round-trip", () => {
    const dir = tmp();
    const { bytes } = exportGem(gemWith("shared-hygiene"));
    const { gem } = importGem(bytes);
    installRubricGem(gem, dir);
    expect(loadRubrics(dir).map((r) => r.id)).toContain("shared-hygiene");
  });
});

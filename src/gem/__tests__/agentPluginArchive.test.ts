// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { writeGemArchive, readGemArchive, computeLock } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

const baseGem = (): Gem => ({
  name: "My Test Gem!",
  createdFrom: "unit test",
  artifacts: [{ type: "skill", name: "summarize", source: "standalone", content: "# Summarize\nDo the thing." }],
  checks: [],
  requiredSecrets: [],
});

describe("archive v2: plugin.json", () => {
  it("emits a spec-shaped plugin.json with slugged name", () => {
    const { files } = writeGemArchive(baseGem(), { version: "1.2.0" });
    const p = JSON.parse(files["plugin.json"]);
    expect(p).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "my-test-gem",
      version: "1.2.0",
    });
  });
  it("stamps formatVersion 2 in gem.json and gem.lock, and lock covers plugin.json", () => {
    const { files } = writeGemArchive(baseGem());
    expect(JSON.parse(files["gem.json"]).formatVersion).toBe(2);
    const lock = JSON.parse(files["gem.lock"]);
    expect(lock.formatVersion).toBe(2);
    expect(lock.files["plugin.json"]).toMatch(/^sha256:/);
  });
  it("round-trips: plugin.json is derived output, never read back", () => {
    const gem = baseGem();
    expect(readGemArchive(writeGemArchive(gem).files)).toEqual(gem);
  });
  it("still reads a formatVersion 1 archive (no plugin.json)", () => {
    const files: Record<string, string> = {
      "gem.json": JSON.stringify({
        formatVersion: 1, name: "old", version: "0.1.0", createdFrom: "unit test",
        artifacts: [{ type: "skill", name: "s", path: "skills/s/SKILL.md", source: "standalone" }],
        requiredSecrets: [], checks: [],
      }),
      "skills/s/SKILL.md": "# S",
    };
    files["gem.lock"] = JSON.stringify(computeLock(files));
    const gem = readGemArchive(files);
    expect(gem.name).toBe("old");
    expect(gem.artifacts).toEqual([{ type: "skill", name: "s", source: "standalone", content: "# S" }]);
  });
  it("rejects an unknown formatVersion", () => {
    const files: Record<string, string> = {
      "gem.json": JSON.stringify({ formatVersion: 3, name: "future", version: "0.1.0", createdFrom: "x", artifacts: [], requiredSecrets: [], checks: [] }),
    };
    files["gem.lock"] = JSON.stringify(computeLock(files));
    expect(() => readGemArchive(files)).toThrow(/formatVersion/);
  });
});

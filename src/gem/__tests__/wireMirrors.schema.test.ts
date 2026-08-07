// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { SkillArtifactSchema, GemManifestSchema } from "@agentgem/app/schemas";

describe("wire mirrors preserve v2 archive fields instead of stripping them", () => {
  it("SkillArtifactSchema keeps files and filesTruncated", () => {
    const skill = {
      type: "skill", name: "s", source: "standalone", content: "# S",
      files: [{ path: "scripts/a.sh", content: "#!/bin/sh\n" }],
      filesTruncated: true,
    };
    expect(SkillArtifactSchema.parse(skill)).toEqual(skill);
  });
  it("GemManifestSchema keeps v2 manifest entry fields and newer artifact kinds", () => {
    const manifest = {
      formatVersion: 2, name: "g", version: "0.1.0", createdFrom: "unit test",
      requiredSecrets: [], checks: [],
      artifacts: [
        { type: "skill", name: "s", path: "skills/s/SKILL.md", source: "standalone", files: ["scripts/a.sh"], filesTruncated: true },
        { type: "mcp_server", name: "db", path: "mcp.json", secretRefs: [{ name: "T", location: "env.T" }], extra: { timeoutMs: 5 } },
        { type: "game", name: "pong", path: "games/pong.html", metadata: "{}" },
        { type: "rubric", name: "r", path: "rubrics/r.json" },
        { type: "reference", name: "ref", path: "refs/ref.json" },
      ],
    };
    expect(GemManifestSchema.parse(manifest).artifacts).toEqual(manifest.artifacts);
  });
});

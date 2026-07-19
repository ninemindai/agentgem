// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The /gemit skill is deliberately THIN: run the CLI, relay the tier, offer --share.
// This guard keeps scoring logic out of the skill and the one-liner exact.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const md = (): string => readFileSync(join(process.cwd(), "skills/gemit/SKILL.md"), "utf8");

describe("gemit skill", () => {
  it("is a skills.sh-discoverable skill file", () => {
    expect(md()).toMatch(/^---\nname: gemit\ndescription: \S/);
  });

  it("carries the exact one-liner and the share offer", () => {
    expect(md()).toContain("npx -y @ninemind/agentgem gemit");
    expect(md()).toContain("--share");
  });

  it("keeps all scoring in the CLI and the publish consent with the user", () => {
    expect(md()).toContain("Never estimate, adjust, or re-derive a score");
    expect(md()).toMatch(/Don't pass `--yes`/);
  });

  it("stays thin", () => {
    expect(md().length).toBeLessThan(3000);
  });
});

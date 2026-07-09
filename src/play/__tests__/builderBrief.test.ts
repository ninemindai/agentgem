// src/play/__tests__/builderBrief.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MINIAPP_BUILDER_BRIEF } from "@agentgem/play";

const md = (): string => readFileSync(join(process.cwd(), "skills/agentgem-miniapp/SKILL.md"), "utf8");

describe("agentgem-miniapp skill", () => {
  it("is a skills.sh-discoverable skill file", () => {
    // frontmatter on line 1 — a leading comment hides the skill from the skills.sh CLI
    expect(md()).toMatch(/^---\nname: agentgem-miniapp\ndescription: \S/);
  });

  it("mirrors MINIAPP_BUILDER_BRIEF verbatim (drift guard)", () => {
    // SKILL.md is a VIEW of the constant: frontmatter + heading on top, body byte-identical below.
    expect(md().endsWith(MINIAPP_BUILDER_BRIEF)).toBe(true);
  });

  it("names every host tool the miniapp can call", () => {
    for (const tool of [
      "agentgem_get_session_data",
      "agentgem_get_inventory",
      "agentgem_subscribe_sessions",
      "agentgem_invoke_agent",
    ]) expect(MINIAPP_BUILDER_BRIEF).toContain(tool);
  });

  it("teaches the notification subscription that shipped broken once", () => {
    expect(MINIAPP_BUILDER_BRIEF).toContain("ui/notifications/tool-result");
    expect(MINIAPP_BUILDER_BRIEF).toContain("subscribe by METHOD, never by tool name");
  });

  it("states the seal, the capability declaration, and the redaction boundary", () => {
    expect(MINIAPP_BUILDER_BRIEF).toContain("default-src 'none'");
    expect(MINIAPP_BUILDER_BRIEF).toContain("needs");
    expect(MINIAPP_BUILDER_BRIEF).toContain("redactForBake");
  });

  it("says invoke-agent is read-only", () => {
    expect(MINIAPP_BUILDER_BRIEF).toContain("read-only");
  });
});

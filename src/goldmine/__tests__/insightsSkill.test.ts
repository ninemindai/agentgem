// src/goldmine/__tests__/insightsSkill.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("agentgem-insights skill", () => {
  const md = () => read("skills/agentgem-insights/SKILL.md");

  it("exists with frontmatter name and description", () => {
    expect(md()).toMatch(/^<!--[^]*?-->\n---\nname: agentgem-insights\ndescription: /);
  });

  it("uses the exact SessionOutcome enum spellings so reports stay comparable", () => {
    const s = md();
    expect(s).toContain("mostly_achieved");
    expect(s).toContain("partially_achieved");
    expect(s).toContain("not_achieved");
  });

  it("keeps the honesty rules: judged not verified, friction grounded in transcripts", () => {
    const s = md();
    // Exact prohibition: outcomes are the judge's opinion, never "verified"
    expect(s).toContain('never call them "verified"');
    expect(s).toContain("get_session_transcript");
    expect(s.toLowerCase()).toContain("ground");
  });

  it("ends at the publish twist, not CLAUDE.md tweaks", () => {
    const s = md();
    expect(s).toContain("agentgem-share");
    expect(s).toContain("publish");
    expect(s).toContain("agentgem learn");
  });
});

describe("agentgem-retro skill", () => {
  const md = () => read("skills/agentgem-retro/SKILL.md");

  it("exists with frontmatter name and description", () => {
    expect(md()).toMatch(/^<!--[^]*?-->\n---\nname: agentgem-retro\ndescription: /);
  });

  it("drives get_behavior_findings and verifies against transcripts before advising", () => {
    const s = md();
    expect(s).toContain("get_behavior_findings");
    expect(s).toContain("get_session_transcript");
    expect(s).toContain("before advising");
  });
});

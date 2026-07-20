import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skillName = vi.hoisted(() => ({ current: "ai-engineer" }));
// `assertSourcePath` is left as the REAL implementation (via importOriginal) so the path-guard
// tests below exercise the actual kind-dispatch regexes, not a re-implementation of them here.
// Only the source lookup / network import are faked.
vi.mock("@agentgem/distribute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentgem/distribute")>();
  return {
    ...actual,
    curatedSourceById: (id: string) => {
      if (id === "agency-agents") return { id, kind: "agency-layout" } as never;
      if (id === "skills-source") return { id, kind: "skills-layout" } as never;
      return undefined;
    },
    cfgForCuratedSource: () => ({}),
    importSourceSkill: async () => ({ type: "skill", name: skillName.current, source: "agency-agents", content: "SKILL_BODY" }),
  };
});

import { installAgencySkill } from "@agentgem/app/sourcesCore";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agsrc-")); skillName.current = "ai-engineer"; });

describe("installAgencySkill", () => {
  it("writes SKILL.md under <home>/.agents/skills/<name>", async () => {
    const r = await installAgencySkill("agency-agents", "engineering/ai-engineer.md", { home });
    expect(r.skill).toBe("ai-engineer");
    expect(readFileSync(join(home, ".agents", "skills", "ai-engineer", "SKILL.md"), "utf8")).toBe("SKILL_BODY");
    expect(r.ok).toBe(true);
  });
  it("dry-run returns content without writing", async () => {
    const r = await installAgencySkill("agency-agents", "engineering/ai-engineer.md", { home, dryRun: true });
    expect(r.content).toBe("SKILL_BODY");
    expect(existsSync(join(home, ".agents", "skills", "ai-engineer"))).toBe(false);
  });
  it("rejects an unknown source", async () => {
    await expect(installAgencySkill("nope", "engineering/ai-engineer.md", { home })).rejects.toThrow(/Unknown curated source/);
  });
  it("rejects a traversal path", async () => {
    await expect(installAgencySkill("agency-agents", "../etc/passwd.md", { home })).rejects.toThrow(/Invalid agent path/);
  });
  it("installs OK for a skill name with uppercase/dot characters", async () => {
    skillName.current = "AI.Engineer-v2";
    const r = await installAgencySkill("agency-agents", "engineering/ai-engineer.md", { home });
    expect(r.skill).toBe("AI.Engineer-v2");
    expect(readFileSync(join(home, ".agents", "skills", "AI.Engineer-v2", "SKILL.md"), "utf8")).toBe("SKILL_BODY");
  });
  it("rejects a skill name containing '..'", async () => {
    skillName.current = "foo..bar";
    await expect(installAgencySkill("agency-agents", "engineering/ai-engineer.md", { home })).rejects.toThrow(/Unsafe skill name/);
  });
  it("rejects a skill name containing '/'", async () => {
    skillName.current = "foo/bar";
    await expect(installAgencySkill("agency-agents", "engineering/ai-engineer.md", { home })).rejects.toThrow(/Unsafe skill name/);
  });

  describe("dispatch by source.kind (skills-layout)", () => {
    it("installs a skills-layout source's SKILL.md", async () => {
      const r = await installAgencySkill("skills-source", "foo/SKILL.md", { home });
      expect(r.skill).toBe("ai-engineer");
      expect(readFileSync(join(home, ".agents", "skills", "ai-engineer", "SKILL.md"), "utf8")).toBe("SKILL_BODY");
    });
    it("rejects a path that isn't a SKILL.md for a skills-layout source", async () => {
      await expect(installAgencySkill("skills-source", "foo/notaskill.md", { home })).rejects.toThrow(/Invalid skill path/);
    });
    it("rejects a traversal path for a skills-layout source", async () => {
      await expect(installAgencySkill("skills-source", "../etc/SKILL.md", { home })).rejects.toThrow(/Invalid skill path/);
    });
  });
});

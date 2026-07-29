import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skillName = vi.hoisted(() => ({ current: "ai-engineer" }));
// Bundle fixture for the sibling-files tests; undefined for every other test so the
// pre-existing single-file expectations are untouched.
const skillFiles = vi.hoisted(() => ({ current: undefined as { path: string; content: string }[] | undefined }));
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
    importSourceSkill: async () => ({ type: "skill", name: skillName.current, source: "agency-agents", content: "SKILL_BODY",
      ...(skillFiles.current ? { files: skillFiles.current } : {}) }),
  };
});

import { installAgencySkill } from "@agentgem/app/sourcesCore";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agsrc-")); skillName.current = "ai-engineer"; skillFiles.current = undefined; });

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

// A progressive-disclosure skill is only usable if the files its SKILL.md points at
// land next to it. The GitHub tree is untrusted input for a filesystem write, so the
// paths are re-checked here even though the importer already filtered them.
describe("installAgencySkill — sibling file bundle", () => {
  it("writes bundled files under the skill dir, creating nested dirs", async () => {
    skillFiles.current = [
      { path: "references/loop.md", content: "# loop" },
      { path: "references/deep/extra.md", content: "# extra" },
      { path: "scripts/run.mjs", content: "export const x = 1;" },
    ];
    await installAgencySkill("skills-source", "skills/eng/triangulate/SKILL.md", { home });
    const base = join(home, ".agents", "skills", "ai-engineer");
    expect(readFileSync(join(base, "SKILL.md"), "utf8")).toBe("SKILL_BODY");
    expect(readFileSync(join(base, "references", "loop.md"), "utf8")).toBe("# loop");
    expect(readFileSync(join(base, "references", "deep", "extra.md"), "utf8")).toBe("# extra");
    expect(readFileSync(join(base, "scripts", "run.mjs"), "utf8")).toBe("export const x = 1;");
  });

  it("dry-run writes no bundled files", async () => {
    skillFiles.current = [{ path: "references/loop.md", content: "# loop" }];
    await installAgencySkill("skills-source", "skills/eng/triangulate/SKILL.md", { home, dryRun: true });
    expect(existsSync(join(home, ".agents", "skills", "ai-engineer"))).toBe(false);
  });

  it("refuses a bundle path that would escape the skill dir", async () => {
    skillFiles.current = [{ path: "../../../etc/pwned.md", content: "x" }];
    await expect(installAgencySkill("skills-source", "skills/eng/triangulate/SKILL.md", { home }))
      .rejects.toThrow(/Unsafe bundle path/);
    expect(existsSync(join(home, ".agents", "skills", "ai-engineer", "SKILL.md"))).toBe(false);
  });

  it("reports how many bundled files were written", async () => {
    skillFiles.current = [{ path: "references/a.md", content: "a" }, { path: "references/b.md", content: "b" }];
    const r = await installAgencySkill("skills-source", "skills/eng/triangulate/SKILL.md", { home });
    expect(r.files).toBe(2);
  });
});

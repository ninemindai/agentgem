// src/__tests__/skillsLayout.test.ts
//
// NOTE on test placement: this exercises code that lives in packages/distribute/src/skillsLayout.ts
// (imported here via the "@agentgem/distribute" package, same as agencyAgents.test.ts) rather than
// living under packages/distribute/src/__tests__ itself — root vitest.config only globs
// "dist/**/__tests__/**/*.test.js" (relative to the repo root), so a test compiled under
// packages/distribute/dist/__tests__ would never actually run. Verified empirically with a throwaway
// probe file before writing this one for real.
import { describe, it, expect } from "vitest";
import type { Http, GithubCfg } from "@agentgem/distribute";
import {
  listSkillMd,
  fetchSkillsDivisions,
  listSkillsAgents,
  fetchSkillsEntry,
  importSkillsSkill,
  assertSkillsPath,
  SKILLS_PATH_RE,
} from "@agentgem/distribute";

const ASK_MATT = `---
name: ask-matt
description: Answers questions the way Matt would.
---

# Ask Matt

Body content for ask-matt.
`;

const OTHER_SKILL = `---
name: other-skill
description: Does something else entirely.
---

Body for other-skill.
`;

// No frontmatter \`name\` — name must fall back to the directory-derived name.
const NO_FM_NAME = `---
description: A skill with no explicit name in frontmatter.
---

Body.
`;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

// A tree with a few real skills/<group>/<name>/SKILL.md blobs, one root-level skill (division
// "root"), one under deprecated/ (excluded), one under .github/ (excluded, dotdir), and a
// directory entry (not a blob, must be filtered out regardless of name).
const TREE = [
  { path: "skills/engineering/ask-matt/SKILL.md", type: "blob" },
  { path: "skills/engineering/other-skill/SKILL.md", type: "blob" },
  { path: "skills/marketing/campaign-writer/SKILL.md", type: "blob" },
  { path: "toplevel-skill/SKILL.md", type: "blob" },
  { path: "skills/deprecated/old-thing/SKILL.md", type: "blob" },
  { path: ".github/SKILL.md", type: "blob" },
  { path: "skills/engineering/ask-matt", type: "tree" },
];

const CONTENTS: Record<string, unknown> = {
  "skills/engineering/ask-matt/SKILL.md": { content: b64(ASK_MATT), encoding: "base64" },
  "skills/engineering/other-skill/SKILL.md": { content: b64(OTHER_SKILL), encoding: "base64" },
  "skills/marketing/campaign-writer/SKILL.md": { content: b64(NO_FM_NAME), encoding: "base64" },
};

// A fake Http serving both the git/trees (recursive listing) and contents (single file) GitHub
// endpoints from fixed fixtures.
function fakeHttp(): Http {
  return async (url) => {
    if (url.includes("/git/trees/")) {
      return { status: 200, text: async () => JSON.stringify({ tree: TREE }) };
    }
    const m = url.match(/\/contents\/([^?]*)\?/);
    const path = decodeURIComponent(m ? m[1] : "");
    if (!(path in CONTENTS)) return { status: 404, text: async () => `no route for '${path}'` };
    return { status: 200, text: async () => JSON.stringify(CONTENTS[path]) };
  };
}
const CFG: GithubCfg = { repo: "mattpocock/skills", ref: "main" };

describe("assertSkillsPath", () => {
  it("accepts a valid <dir>/SKILL.md path", () => {
    expect(assertSkillsPath("skills/engineering/ask-matt/SKILL.md")).toBe("skills/engineering/ask-matt/SKILL.md");
  });
  it("rejects a traversal path", () => {
    expect(() => assertSkillsPath("../../etc/SKILL.md")).toThrow(/Invalid skill path/);
  });
  it("rejects a path that isn't a SKILL.md", () => {
    expect(() => assertSkillsPath("skills/engineering/ask-matt/README.md")).toThrow(/Invalid skill path/);
  });
  it("rejects a bare SKILL.md with no directory segment", () => {
    expect(() => assertSkillsPath("SKILL.md")).toThrow(/Invalid skill path/);
    expect(SKILLS_PATH_RE.test("SKILL.md")).toBe(false);
  });
});

describe("skills-layout network helpers over a fake Http", () => {
  it("listSkillMd finds every SKILL.md blob, excluding deprecated/dotdir/non-blob entries", async () => {
    const paths = await listSkillMd(CFG, fakeHttp());
    expect(paths).toEqual([
      "skills/engineering/ask-matt/SKILL.md",
      "skills/engineering/other-skill/SKILL.md",
      "skills/marketing/campaign-writer/SKILL.md",
      "toplevel-skill/SKILL.md",
    ]);
  });

  it("fetchSkillsDivisions derives divisions from paths, sorted, including root", async () => {
    const divisions = await fetchSkillsDivisions(CFG, fakeHttp());
    expect(divisions).toEqual([
      { key: "engineering", label: "Engineering" },
      { key: "marketing", label: "Marketing" },
      { key: "root", label: "Root" },
    ]);
  });

  it("listSkillsAgents lists skill refs under a division, sorted by name", async () => {
    const agents = await listSkillsAgents("engineering", CFG, fakeHttp());
    expect(agents).toEqual([
      { division: "engineering", slug: "ask-matt", name: "ask-matt", path: "skills/engineering/ask-matt/SKILL.md" },
      { division: "engineering", slug: "other-skill", name: "other-skill", path: "skills/engineering/other-skill/SKILL.md" },
    ]);
  });

  it("listSkillsAgents for the root division returns the top-level skill", async () => {
    const agents = await listSkillsAgents("root", CFG, fakeHttp());
    expect(agents).toEqual([{ division: "root", slug: "toplevel-skill", name: "toplevel-skill", path: "toplevel-skill/SKILL.md" }]);
  });

  it("fetchSkillsEntry parses frontmatter name/description", async () => {
    const entry = await fetchSkillsEntry("skills/engineering/ask-matt/SKILL.md", CFG, fakeHttp());
    expect(entry).toEqual({
      division: "engineering",
      slug: "ask-matt",
      name: "ask-matt",
      path: "skills/engineering/ask-matt/SKILL.md",
      description: "Answers questions the way Matt would.",
    });
  });

  it("fetchSkillsEntry falls back to the directory-derived name when frontmatter has none", async () => {
    const entry = await fetchSkillsEntry("skills/marketing/campaign-writer/SKILL.md", CFG, fakeHttp());
    expect(entry.name).toBe("campaign-writer");
    expect(entry.description).toBe("A skill with no explicit name in frontmatter.");
  });

  it("importSkillsSkill returns the SKILL.md verbatim, with a division-scoped source label", async () => {
    const path = "skills/engineering/ask-matt/SKILL.md";
    const skill = await importSkillsSkill(path, CFG, fakeHttp(), "mattpocock/skills");
    expect(skill.type).toBe("skill");
    expect(skill.name).toBe("ask-matt");
    expect(skill.description).toBe("Answers questions the way Matt would.");
    expect(skill.source).toBe("mattpocock/skills:engineering");
    expect(skill.content).toBe(ASK_MATT); // verbatim — no re-wrapping/normalization
  });

  it("importSkillsSkill falls back the source label to cfg.repo when none is given", async () => {
    const path = "skills/engineering/other-skill/SKILL.md";
    const skill = await importSkillsSkill(path, CFG, fakeHttp());
    expect(skill.source).toBe("mattpocock/skills:engineering");
  });

  it("throws a clear error on a missing path", async () => {
    await expect(importSkillsSkill("skills/engineering/nope/SKILL.md", CFG, fakeHttp())).rejects.toThrow(/→ 404/);
  });
});

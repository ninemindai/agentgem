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
  MAX_BUNDLE_FILES,
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

// ── Skill bundles: a progressive-disclosure skill's SKILL.md points at sibling
// files (references/*.md, scripts/*.mjs). Importing only SKILL.md leaves those
// links dangling, which is worse than useless — the body instructs the agent to
// read files that were never fetched.
describe("importSkillsSkill — sibling file bundle", () => {
  const SKILL = `---\nname: triangulate\ndescription: d\n---\nRead references/loop.md.\n`;
  const BUNDLE_TREE = [
    { path: "skills/eng/triangulate/SKILL.md", type: "blob" },
    { path: "skills/eng/triangulate/references/loop.md", type: "blob" },
    { path: "skills/eng/triangulate/references/deep/extra.md", type: "blob" },
    { path: "skills/eng/triangulate/scripts/run.mjs", type: "blob" },
    { path: "skills/eng/triangulate/logo.png", type: "blob" },       // binary — not bundled
    { path: "skills/eng/triangulate/references", type: "tree" },     // not a blob
    { path: "skills/eng/other/SKILL.md", type: "blob" },             // a DIFFERENT skill
    { path: "skills/eng/other/references/nope.md", type: "blob" },   // must not leak in
  ];
  const BUNDLE_CONTENTS: Record<string, unknown> = {
    "skills/eng/triangulate/SKILL.md": { content: b64(SKILL), encoding: "base64" },
    "skills/eng/triangulate/references/loop.md": { content: b64("# loop"), encoding: "base64" },
    "skills/eng/triangulate/references/deep/extra.md": { content: b64("# extra"), encoding: "base64" },
    "skills/eng/triangulate/scripts/run.mjs": { content: b64("export const x = 1;"), encoding: "base64" },
    "skills/eng/triangulate/logo.png": { content: b64("\x89PNG"), encoding: "base64" },
    "skills/eng/other/references/nope.md": { content: b64("# nope"), encoding: "base64" },
  };
  function bundleHttp(tree = BUNDLE_TREE): Http {
    return async (url) => {
      if (url.includes("/git/trees/")) return { status: 200, text: async () => JSON.stringify({ tree }) };
      const m = url.match(/\/contents\/([^?]*)\?/);
      const path = decodeURIComponent(m ? m[1] : "");
      if (!(path in BUNDLE_CONTENTS)) return { status: 404, text: async () => `no route for '${path}'` };
      return { status: 200, text: async () => JSON.stringify(BUNDLE_CONTENTS[path]) };
    };
  }

  it("bundles sibling text files with paths relative to the skill dir", async () => {
    const s = await importSkillsSkill("skills/eng/triangulate/SKILL.md", CFG, bundleHttp());
    expect(s.files?.map((f) => f.path).sort()).toEqual([
      "references/deep/extra.md", "references/loop.md", "scripts/run.mjs",
    ]);
    expect(s.files?.find((f) => f.path === "references/loop.md")?.content).toBe("# loop");
  });

  it("never bundles the SKILL.md itself (it is written from `content`)", async () => {
    const s = await importSkillsSkill("skills/eng/triangulate/SKILL.md", CFG, bundleHttp());
    expect(s.files?.some((f) => f.path === "SKILL.md")).toBe(false);
  });

  it("never leaks files from a sibling skill's directory", async () => {
    const s = await importSkillsSkill("skills/eng/triangulate/SKILL.md", CFG, bundleHttp());
    expect(JSON.stringify(s.files)).not.toContain("nope");
  });

  it("marks the bundle incomplete when a non-text sibling is skipped", async () => {
    const s = await importSkillsSkill("skills/eng/triangulate/SKILL.md", CFG, bundleHttp());
    expect(s.filesTruncated).toBe(true);   // logo.png was skipped — say so, never silently
  });

  it("is complete (no truncation flag) when every sibling was bundled", async () => {
    const noBinary = BUNDLE_TREE.filter((e) => !e.path.endsWith(".png") && !e.path.startsWith("skills/eng/other"));
    const s = await importSkillsSkill("skills/eng/triangulate/SKILL.md", CFG, bundleHttp(noBinary));
    expect(s.filesTruncated).toBeFalsy();
    expect(s.files).toHaveLength(3);
  });

  it("bounds the bundle by file count and says so", async () => {
    const many = [
      { path: "skills/eng/triangulate/SKILL.md", type: "blob" },
      ...Array.from({ length: MAX_BUNDLE_FILES + 3 }, (_, i) => ({ path: `skills/eng/triangulate/references/r${i}.md`, type: "blob" })),
    ];
    for (let i = 0; i < MAX_BUNDLE_FILES + 3; i++) BUNDLE_CONTENTS[`skills/eng/triangulate/references/r${i}.md`] = { content: b64(`# r${i}`), encoding: "base64" };
    const s = await importSkillsSkill("skills/eng/triangulate/SKILL.md", CFG, bundleHttp(many));
    expect(s.files).toHaveLength(MAX_BUNDLE_FILES);
    expect(s.filesTruncated).toBe(true);
  });

  it("still imports the skill when the bundle listing fails (bundle is an enhancement)", async () => {
    const http: Http = async (url) => {
      if (url.includes("/git/trees/")) return { status: 500, text: async () => "boom" };
      const m = url.match(/\/contents\/([^?]*)\?/);
      const path = decodeURIComponent(m ? m[1] : "");
      return { status: 200, text: async () => JSON.stringify(BUNDLE_CONTENTS[path]) };
    };
    const s = await importSkillsSkill("skills/eng/triangulate/SKILL.md", CFG, http);
    expect(s.name).toBe("triangulate");
    expect(s.content).toContain("Read references/loop.md");
    expect(s.filesTruncated).toBe(true);   // we could not confirm completeness
  });
});

// `.agents/skills/` and `.claude/skills/` are the two standard on-disk skill roots — our own
// installer writes to ~/.agents/skills/<name>. Excluding them as "dotdirs" hid every skill in
// repos that follow the convention (QoderAI/better-harness keeps all four of its skills there).
// Other dotdirs (.github, .vscode) stay excluded: those are repo tooling, not skills.
describe("listSkillMd — standard dot-prefixed skill roots", () => {
  const DOT_TREE = [
    { path: ".agents/skills/triangulate/SKILL.md", type: "blob" },
    { path: ".claude/skills/reviewer/SKILL.md", type: "blob" },
    { path: ".github/workflows/thing/SKILL.md", type: "blob" },   // tooling — still excluded
    { path: ".vscode/foo/SKILL.md", type: "blob" },               // tooling — still excluded
    { path: "skills/normal/SKILL.md", type: "blob" },
  ];
  const http: Http = async (url) => {
    if (url.includes("/git/trees/")) return { status: 200, text: async () => JSON.stringify({ tree: DOT_TREE }) };
    return { status: 404, text: async () => "x" };
  };

  it("includes .agents/ and .claude/ skills but still excludes tooling dotdirs", async () => {
    expect(await listSkillMd(CFG, http)).toEqual([
      ".agents/skills/triangulate/SKILL.md",
      ".claude/skills/reviewer/SKILL.md",
      "skills/normal/SKILL.md",
    ]);
  });

  it("accepts a dot-rooted skill path through the input guard", () => {
    expect(assertSkillsPath(".agents/skills/triangulate/SKILL.md")).toBe(".agents/skills/triangulate/SKILL.md");
  });
});

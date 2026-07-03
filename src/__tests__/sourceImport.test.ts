// src/__tests__/sourceImport.test.ts
//
// Exercises the dispatch-by-kind layer (packages/distribute/src/sourceImport.ts) that lets the
// server controller/core treat every CuratedSource uniformly. See skillsLayout.test.ts for the
// note on why this lives under root src/__tests__ rather than packages/distribute/src/__tests__.
import { describe, it, expect } from "vitest";
import type { Http, GithubCfg, CuratedSource } from "@agentgem/distribute";
import { assertSourcePath, sourceDivisions, sourceAgents, sourceEntry, importSourceSkill } from "@agentgem/distribute";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const AGENCY_MD = `---
name: Frontend Developer
description: Builds web apps.
color: cyan
emoji: 🖥️
vibe: Ships pixel-perfect UI.
---

Body.
`;

const SKILL_MD = `---
name: ask-matt
description: Answers questions the way Matt would.
---

Body.
`;

const AGENCY_SOURCE: CuratedSource = {
  id: "agency-agents", label: "The Agency", description: "d", repo: "msitarzewski/agency-agents", ref: "main", kind: "agency-layout",
};
const SKILLS_SOURCE: CuratedSource = {
  id: "mattpocock-skills", label: "mattpocock/skills", description: "d", repo: "mattpocock/skills", ref: "main", kind: "skills-layout",
};
const CFG: GithubCfg = { repo: "irrelevant/repo", ref: "main" };

// Serves both the agency-layout Contents-API dir/file routes and a git/trees route (for the
// skills-layout divisions/agents listing), from one fixed set of fixtures.
function fakeHttp(): Http {
  const contentsRoutes: Record<string, unknown> = {
    "engineering/engineering-frontend-developer.md": { content: b64(AGENCY_MD), encoding: "base64" },
    "skills/engineering/ask-matt/SKILL.md": { content: b64(SKILL_MD), encoding: "base64" },
  };
  const tree = [{ path: "skills/engineering/ask-matt/SKILL.md", type: "blob" }];
  return async (url) => {
    if (url.includes("/git/trees/")) return { status: 200, text: async () => JSON.stringify({ tree }) };
    const m = url.match(/\/contents\/([^?]*)\?/);
    const path = decodeURIComponent(m ? m[1] : "");
    if (!(path in contentsRoutes)) return { status: 404, text: async () => `no route for '${path}'` };
    return { status: 200, text: async () => JSON.stringify(contentsRoutes[path]) };
  };
}

describe("assertSourcePath dispatches by source.kind", () => {
  it("agency-layout: accepts <division>/<file>.md, rejects traversal / wrong shape", () => {
    expect(assertSourcePath(AGENCY_SOURCE, "engineering/frontend.md")).toBe("engineering/frontend.md");
    expect(() => assertSourcePath(AGENCY_SOURCE, "../../etc/passwd")).toThrow(/Invalid agent path/);
    expect(() => assertSourcePath(AGENCY_SOURCE, "engineering/sub/dir/x.md")).toThrow(/Invalid agent path/);
  });
  it("skills-layout: accepts <dir>/SKILL.md, rejects traversal / wrong shape", () => {
    expect(assertSourcePath(SKILLS_SOURCE, "skills/engineering/ask-matt/SKILL.md")).toBe("skills/engineering/ask-matt/SKILL.md");
    expect(() => assertSourcePath(SKILLS_SOURCE, "../../etc/passwd")).toThrow(/Invalid skill path/);
    expect(() => assertSourcePath(SKILLS_SOURCE, "skills/engineering/ask-matt/README.md")).toThrow(/Invalid skill path/);
  });
});

describe("sourceDivisions/sourceAgents/sourceEntry/importSourceSkill dispatch by source.kind", () => {
  it("routes an agency-layout source through the agency adapter", async () => {
    const http = fakeHttp();
    const entry = await sourceEntry(AGENCY_SOURCE, "engineering/engineering-frontend-developer.md", CFG, http);
    expect(entry.name).toBe("frontend-developer");
    expect(entry.emoji).toBe("🖥️");
    const skill = await importSourceSkill(AGENCY_SOURCE, "engineering/engineering-frontend-developer.md", CFG, http);
    expect(skill.source).toBe("agency-agents:engineering");
    expect(skill.content).toMatch(/^---\nname: frontend-developer/); // agency import re-normalizes frontmatter
  });

  it("routes a skills-layout source through the skills adapter", async () => {
    const http = fakeHttp();
    const divisions = await sourceDivisions(SKILLS_SOURCE, CFG, http);
    expect(divisions).toEqual([{ key: "engineering", label: "Engineering" }]);
    const agents = await sourceAgents(SKILLS_SOURCE, "engineering", CFG, http);
    expect(agents).toEqual([{ division: "engineering", slug: "ask-matt", name: "ask-matt", path: "skills/engineering/ask-matt/SKILL.md" }]);
    const entry = await sourceEntry(SKILLS_SOURCE, "skills/engineering/ask-matt/SKILL.md", CFG, http);
    expect(entry.name).toBe("ask-matt");
    const skill = await importSourceSkill(SKILLS_SOURCE, "skills/engineering/ask-matt/SKILL.md", CFG, http);
    expect(skill.source).toBe("mattpocock-skills:engineering"); // sourceLabel = source.id, not cfg.repo
    expect(skill.content).toBe(SKILL_MD); // skills import is verbatim — no re-wrapping
  });
});

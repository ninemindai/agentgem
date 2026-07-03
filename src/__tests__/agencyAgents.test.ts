// src/__tests__/agencyAgents.test.ts
import { describe, it, expect } from "vitest";
import type { Http, GithubCfg } from "@agentgem/distribute";
import {
  parseAgentFrontmatter,
  splitFrontmatter,
  agentMdToEntry,
  agentMdToSkill,
  fetchAgencyDivisions,
  listAgencyDivisions,
  listAgencyAgents,
  importAgencyAgentSkill,
  fetchAgencyAgentEntry,
  NON_AGENT_DIRS,
} from "@agentgem/distribute";

// Trimmed fixtures mirroring the real files (frontmatter verbatim from the repo; bodies shortened).
const FRONTEND = `---
name: Frontend Developer
description: Expert frontend developer specializing in modern web technologies, React/Vue/Angular frameworks, UI implementation, and performance optimization
color: cyan
emoji: 🖥️
vibe: Builds responsive, accessible web apps with pixel-perfect precision.
---

# Frontend Developer Agent Personality

## Your Identity & Memory
You are the Frontend Developer...
`;

// TikTok's color is quoted ("#000000") — exercises quote-stripping.
const TIKTOK = `---
name: TikTok Strategist
description: Expert TikTok marketing specialist focused on viral content creation, algorithm optimization, and community building.
color: "#000000"
emoji: 🎵
vibe: Rides the algorithm and builds community through authentic TikTok culture.
---

## Identity & Memory
You are the TikTok Strategist...
`;

// Synthetic: no `description` key → description must fall back to `vibe`.
const VIBE_ONLY = `---
name: Reality Checker
color: red
emoji: 🧐
vibe: Cuts through hype with evidence.
---

Body about reality checking.
`;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

// A fake Http that serves a fixed map of repo path -> Contents API JSON (dir listing or file node).
function fakeHttp(routes: Record<string, unknown>): Http {
  return async (url) => {
    const m = url.match(/\/contents\/([^?]*)\?/);
    const path = decodeURIComponent(m ? m[1] : "");
    if (!(path in routes)) return { status: 404, text: async () => `no route for '${path}'` };
    return { status: 200, text: async () => JSON.stringify(routes[path]) };
  };
}
const CFG: GithubCfg = { repo: "msitarzewski/agency-agents", ref: "main" };

describe("agency-agents frontmatter parsing", () => {
  it("extracts all five keys", () => {
    const { fm, body } = parseAgentFrontmatter(FRONTEND);
    expect(fm.name).toBe("Frontend Developer");
    expect(fm.description).toMatch(/^Expert frontend developer/);
    expect(fm.color).toBe("cyan");
    expect(fm.emoji).toBe("🖥️");
    expect(fm.vibe).toBe("Builds responsive, accessible web apps with pixel-perfect precision.");
    expect(body).toMatch(/# Frontend Developer Agent Personality/);
    expect(body).not.toMatch(/^---/);
  });

  it("strips surrounding quotes from values", () => {
    const { fm } = parseAgentFrontmatter(TIKTOK);
    expect(fm.color).toBe("#000000"); // was "#000000" with quotes
    expect(fm.emoji).toBe("🎵");
  });

  it("splitFrontmatter returns the whole input as body when there is no frontmatter", () => {
    const { fm, body } = splitFrontmatter("no frontmatter here");
    expect(fm).toBe("");
    expect(body).toBe("no frontmatter here");
  });
});

describe("agentMdToEntry", () => {
  it("derives division, slug, name and carries display metadata", () => {
    const e = agentMdToEntry("engineering/engineering-frontend-developer.md", FRONTEND);
    expect(e.division).toBe("engineering");
    expect(e.slug).toBe("engineering-frontend-developer");
    expect(e.name).toBe("frontend-developer"); // leading "engineering-" stripped
    expect(e.emoji).toBe("🖥️");
    expect(e.color).toBe("cyan");
    expect(e.vibe).toMatch(/pixel-perfect/);
    expect(e.description).toMatch(/^Expert frontend developer/);
  });

  it("falls back to vibe for description when the key is absent", () => {
    const e = agentMdToEntry("testing/testing-reality-checker.md", VIBE_ONLY);
    expect(e.name).toBe("reality-checker");
    expect(e.description).toBe("Cuts through hype with evidence.");
  });
});

describe("agentMdToSkill", () => {
  it("produces a clean skill artifact with normalized content", () => {
    const s = agentMdToSkill("marketing/marketing-tiktok-strategist.md", TIKTOK);
    expect(s.type).toBe("skill");
    expect(s.name).toBe("tiktok-strategist");
    expect(s.source).toBe("agency-agents:marketing");
    expect(s.description).toMatch(/^Expert TikTok marketing/);
    // Normalized frontmatter: only name + description, no color/emoji/vibe leakage.
    expect(s.content).toMatch(/^---\nname: tiktok-strategist\ndescription: Expert TikTok/);
    expect(s.content).not.toMatch(/emoji:/);
    expect(s.content).not.toMatch(/color:/);
    expect(s.content).not.toMatch(/vibe:/);
    expect(s.content).toMatch(/You are the TikTok Strategist/);
  });

  it("uses vibe as the description fallback in the skill too", () => {
    const s = agentMdToSkill("testing/testing-reality-checker.md", VIBE_ONLY);
    expect(s.description).toBe("Cuts through hype with evidence.");
    expect(s.content).toMatch(/^---\nname: reality-checker\ndescription: Cuts through hype/);
  });
});

const DIVISIONS_JSON = JSON.stringify({
  _note: "source of truth",
  divisions: {
    engineering: { label: "Engineering", icon: "Code", color: "#3B82F6" },
    marketing: { label: "Marketing", icon: "Megaphone", color: "#F97316" },
    "game-development": { label: "Game Development", icon: "Gamepad2", color: "#A855F7" },
  },
});

describe("agency-agents network helpers over a fake Http", () => {
  it("fetches divisions from divisions.json with label/icon/color, sorted by key", async () => {
    const http = fakeHttp({ "divisions.json": { content: b64(DIVISIONS_JSON), encoding: "base64" } });
    const divisions = await fetchAgencyDivisions(CFG, http);
    expect(divisions.map((d) => d.key)).toEqual(["engineering", "game-development", "marketing"]);
    const eng = divisions.find((d) => d.key === "engineering")!;
    expect(eng.label).toBe("Engineering");
    expect(eng.icon).toBe("Code");
    expect(eng.color).toBe("#3B82F6");
  });

  it("listAgencyDivisions returns just the keys from divisions.json", async () => {
    const http = fakeHttp({ "divisions.json": { content: b64(DIVISIONS_JSON), encoding: "base64" } });
    expect(await listAgencyDivisions(CFG, http)).toEqual(["engineering", "game-development", "marketing"]);
  });

  it("falls back to a root walk (minus non-agent dirs) when divisions.json is absent", async () => {
    const http = fakeHttp({
      // no "divisions.json" route → 404 → fallback path
      "": [
        { name: "engineering", path: "engineering", type: "dir" },
        { name: "marketing", path: "marketing", type: "dir" },
        { name: "scripts", path: "scripts", type: "dir" },           // excluded
        { name: "integrations", path: "integrations", type: "dir" }, // excluded
        { name: "README.md", path: "README.md", type: "file" },      // not a dir
      ],
    });
    const divisions = await fetchAgencyDivisions(CFG, http);
    expect(divisions.map((d) => d.key)).toEqual(["engineering", "marketing"]);
    expect(divisions[0].label).toBe("Engineering"); // synthesized (title-cased), no icon/color
    expect(divisions[0].icon).toBeUndefined();
    expect(NON_AGENT_DIRS.has("scripts")).toBe(true);
  });

  it("lists agent files under a division, skipping README", async () => {
    const http = fakeHttp({
      engineering: [
        { name: "engineering-frontend-developer.md", path: "engineering/engineering-frontend-developer.md", type: "file" },
        { name: "engineering-code-reviewer.md", path: "engineering/engineering-code-reviewer.md", type: "file" },
        { name: "README.md", path: "engineering/README.md", type: "file" },
      ],
    });
    const agents = await listAgencyAgents("engineering", CFG, http);
    expect(agents.map((a) => a.name)).toEqual(["code-reviewer", "frontend-developer"]);
    expect(agents[0].path).toBe("engineering/engineering-code-reviewer.md");
  });

  it("imports a single agent file as a skill", async () => {
    const path = "engineering/engineering-frontend-developer.md";
    const http = fakeHttp({ [path]: { content: b64(FRONTEND), encoding: "base64" } });
    const skill = await importAgencyAgentSkill(path, CFG, http);
    expect(skill.name).toBe("frontend-developer");
    expect(skill.source).toBe("agency-agents:engineering");
    expect(skill.content).not.toMatch(/emoji:/);
  });

  it("fetches a browsable entry with display metadata", async () => {
    const path = "marketing/marketing-tiktok-strategist.md";
    const http = fakeHttp({ [path]: { content: b64(TIKTOK), encoding: "base64" } });
    const entry = await fetchAgencyAgentEntry(path, CFG, http);
    expect(entry.emoji).toBe("🎵");
    expect(entry.color).toBe("#000000");
    expect(entry.name).toBe("tiktok-strategist");
  });

  it("throws a clear error on a missing path", async () => {
    const http = fakeHttp({});
    await expect(importAgencyAgentSkill("engineering/nope.md", CFG, http)).rejects.toThrow(/→ 404/);
  });
});

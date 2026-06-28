// src/gem/__tests__/draftStage.test.ts
import { describe, it, expect } from "vitest";
import { distilledSkillMarkdown, distilledToArtifact, stageDistilledDrafts } from "../draftStage.js";
import { buildGem } from "../buildGem.js";
import type { ConfigInventory } from "../types.js";
import type { DistilledSkill } from "../distill.js";

const draft: DistilledSkill = {
  name: "tdd-feature-loop",
  description: "Run the TDD loop for a feature.",
  triggers: ["add a feature with tests"],
  tools: ["Bash", "Edit"],
  mutating: true,
  body: "## Contract\nGuarantees X.\n## Phases\n1. write test\n## Output Format\nA passing suite.",
  evidence: { sessions: 3, exampleSequence: ["Bash:git commit"], root: "/r", provenance: { occurrences: [] } },
  status: "draft",
  confidence: "high",
  origin: "llm",
};

function emptyInv(): ConfigInventory {
  return {
    skills: [], mcpServers: [], instructions: [], hooks: [],
    projects: [{ root: "/r", name: "app", skills: [], mcpServers: [], instructions: [], hooks: [] }],
  };
}

describe("distilledSkillMarkdown", () => {
  it("emits frontmatter + body", () => {
    const md = distilledSkillMarkdown(draft);
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("name: tdd-feature-loop");
    expect(md).toContain("- add a feature with tests");
    expect(md).toContain("mutating: true");
    expect(md).toContain("## Phases");
  });
});

describe("distilledToArtifact", () => {
  it("produces a skill artifact carrying the markdown", () => {
    const a = distilledToArtifact(draft);
    expect(a.type).toBe("skill");
    expect(a.name).toBe("tdd-feature-loop");
    expect(a.content).toContain("## Contract");
  });
});

describe("stageDistilledDrafts", () => {
  it("stages a draft so buildGem can resolve it under the project", () => {
    const staged = stageDistilledDrafts(emptyInv(), [draft], "/r");
    const gem = buildGem(staged, { projects: { "/r": { skills: ["tdd-feature-loop"] } } });
    const art = gem.artifacts.find((a) => a.name === "tdd-feature-loop");
    expect(art?.type).toBe("skill");
  });

  it("does not mutate the input inventory", () => {
    const inv = emptyInv();
    stageDistilledDrafts(inv, [draft], "/r");
    expect(inv.projects![0].skills).toHaveLength(0);
  });

  it("is a no-op for an empty draft list", () => {
    const inv = emptyInv();
    expect(stageDistilledDrafts(inv, [], "/r")).toBe(inv);
  });
});

import { writeDistilledDraft } from "../draftStage.js";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("writeDistilledDraft", () => {
  it("writes SKILL.md under .agentgem/distilled/<name>/ and returns the path", () => {
    const base = mkdtempSync(join(tmpdir(), "draftw-"));
    const path = writeDistilledDraft(draft, base);
    expect(path).toBe(join(base, ".agentgem", "distilled", "tdd-feature-loop", "SKILL.md"));
    expect(existsSync(path)).toBe(true);
    const md = readFileSync(path, "utf8");
    expect(md).toContain("name: tdd-feature-loop");
    expect(md).toContain("## Phases");
    rmSync(base, { recursive: true, force: true });
  });
});

import { stageDraftsByEvidence } from "../draftStage.js";
describe("stageDraftsByEvidence", () => {
  it("stages each draft into the project named by its evidence.root", () => {
    const inv = {
      skills: [], mcpServers: [], instructions: [], hooks: [],
      projects: [
        { root: "/a", name: "a", skills: [], mcpServers: [], instructions: [], hooks: [] },
        { root: "/b", name: "b", skills: [], mcpServers: [], instructions: [], hooks: [] },
      ],
    };
    const dA = { ...draft, name: "draft-a", evidence: { ...draft.evidence, root: "/a" } };
    const dB = { ...draft, name: "draft-b", evidence: { ...draft.evidence, root: "/b" } };
    const out = stageDraftsByEvidence(inv, [dA, dB]);
    const gem = buildGem(out, { projects: { "/a": { skills: ["draft-a"] }, "/b": { skills: ["draft-b"] } } });
    expect(gem.artifacts.map(a => a.name).sort()).toEqual(["draft-a", "draft-b"]);
  });
  it("is a no-op for no drafts", () => {
    const inv = { skills: [], mcpServers: [], instructions: [], hooks: [], projects: [] };
    expect(stageDraftsByEvidence(inv, [])).toBe(inv);
  });
});

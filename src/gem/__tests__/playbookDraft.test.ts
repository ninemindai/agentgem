// src/gem/__tests__/playbookDraft.test.ts
import { describe, it, expect } from "vitest";
import { buildPlaybookGem } from "../../playbookDraft.js";
import { deriveCut, BUILTIN_CUTS } from "@agentgem/model";
import type { DistilledSkill, DistilledLesson } from "@agentgem/insight";

const emptyInv = { skills: [], mcpServers: [], instructions: [], hooks: [] };
const skill = (name: string): DistilledSkill => ({
  name, description: "d", triggers: ["t"], tools: ["Bash"], mutating: false, body: "## Contract\n",
  evidence: { sessions: 2, exampleSequence: [], root: "/r", provenance: { occurrences: [] } },
  status: "draft", confidence: "high", origin: "llm",
});
const lesson = (name: string): DistilledLesson => ({
  name, body: "Always verify before publishing.", importance: "high", status: "draft",
  evidence: { sessions: 1, root: "/r", provenance: { occurrences: [] } },
});

describe("buildPlaybookGem", () => {
  it("assembles a gem from distilled skills + lessons that derives to the playbook cut", () => {
    const { gem, selection } = buildPlaybookGem({
      name: "my-playbook", baseInventory: emptyInv, skills: [skill("ship-loop")], lessons: [lesson("verify-first")],
    });
    expect(gem.name).toBe("my-playbook");
    expect(gem.artifacts.some((a) => a.type === "skill")).toBe(true);
    expect(gem.artifacts.some((a) => a.type === "instructions")).toBe(true);
    expect(deriveCut(BUILTIN_CUTS, gem)).toBe("playbook"); // a distilled-draft skill ⇒ playbook
    expect(selection.skills).toContain("ship-loop");
  });

  it("returns a skill-only gem (no lessons) that still derives to playbook", () => {
    const { gem } = buildPlaybookGem({ name: "p", baseInventory: emptyInv, skills: [skill("a")], lessons: [] });
    expect(deriveCut(BUILTIN_CUTS, gem)).toBe("playbook");
  });
});

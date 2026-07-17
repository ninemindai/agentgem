import { describe, it, expect } from "vitest";
import {
  toUnifiedGems,
  groupGemsByType,
  groupGemsByMaturity,
  groupGemsByValue,
  type UnifiedGem,
} from "../unifiedGems.js";
import type { WorkflowCardModel } from "../groupWorkflows.js";
import type { LedgerGroup } from "../../shared/ledgerModel.js";

const workflow = (overrides: Partial<WorkflowCardModel> = {}): WorkflowCardModel => ({
  root: "/projects/alpha",
  projectLabel: "alpha",
  key: "wf-a",
  name: "Deploy workflow",
  confidence: "high",
  portable: false,
  sessions: 5,
  lastSeenMs: 100,
  ...overrides,
});

const inventoryGroups = (overrides: Partial<Record<string, LedgerGroup["items"]>> = {}): LedgerGroup[] => [
  { key: "skills", label: "Skills", items: overrides.skills ?? [] },
  { key: "subagents", label: "Subagents", items: overrides.subagents ?? [] },
  { key: "mcpServers", label: "MCP Servers", items: overrides.mcpServers ?? [] },
  { key: "instructions", label: "Instructions", items: overrides.instructions ?? [] },
  { key: "hooks", label: "Hooks", items: overrides.hooks ?? [] },
  { key: "rubrics", label: "Rubrics", items: overrides.rubrics ?? [] },
];

describe("toUnifiedGems: workflows", () => {
  it("maps a workflow to type workflow, maturity raw, scorable true, root/key set", () => {
    const [gem] = toUnifiedGems({ workflows: [workflow()], inventory: [], miniapps: [] });
    expect(gem.type).toBe("workflow");
    expect(gem.maturity).toBe("raw");
    expect(gem.scorable).toBe(true);
    expect(gem.root).toBe("/projects/alpha");
    expect(gem.key).toBe("wf-a");
    expect(gem.signal).toEqual({ kind: "confidence", confidence: "high", portable: false });
  });

  it("values a portable workflow worth-sharing regardless of confidence", () => {
    const [gem] = toUnifiedGems({ workflows: [workflow({ portable: true, confidence: "low" })], inventory: [], miniapps: [] });
    expect(gem.value).toBe("worth-sharing");
  });

  it("values a high-confidence non-portable workflow battle-tested", () => {
    const [gem] = toUnifiedGems({ workflows: [workflow({ portable: false, confidence: "high" })], inventory: [], miniapps: [] });
    expect(gem.value).toBe("battle-tested");
  });

  it("values a medium/low-confidence non-portable workflow reusable", () => {
    const [gem] = toUnifiedGems({ workflows: [workflow({ portable: false, confidence: "medium" })], inventory: [], miniapps: [] });
    expect(gem.value).toBe("reusable");
  });

  it("provenance includes session count and project label when sessions > 0", () => {
    const [gem] = toUnifiedGems({ workflows: [workflow({ sessions: 5, projectLabel: "alpha" })], inventory: [], miniapps: [] });
    expect(gem.provenance).toBe("distilled from 5 sessions · alpha");
  });

  it("provenance singularizes for exactly 1 session", () => {
    const [gem] = toUnifiedGems({ workflows: [workflow({ sessions: 1, projectLabel: "alpha" })], inventory: [], miniapps: [] });
    expect(gem.provenance).toBe("distilled from 1 session · alpha");
  });

  it("provenance omits 'distilled from' when sessions is 0", () => {
    const [gem] = toUnifiedGems({ workflows: [workflow({ sessions: 0, projectLabel: "beta" })], inventory: [], miniapps: [] });
    expect(gem.provenance).toBe("· beta");
  });

  it("id is stable and namespaced by root + key", () => {
    const [gem] = toUnifiedGems({ workflows: [workflow({ root: "/p", key: "wf-x" })], inventory: [], miniapps: [] });
    expect(gem.id).toBe("workflow:/p:wf-x");
  });
});

describe("toUnifiedGems: inventory - skills/subagents/rubrics/lessons", () => {
  it("maps skills group to type skill, scorable true", () => {
    const [gem] = toUnifiedGems({
      workflows: [],
      inventory: inventoryGroups({ skills: [{ name: "pdf", invocations: 3, lastUsedMs: 10 }] }),
      miniapps: [],
    });
    expect(gem.type).toBe("skill");
    expect(gem.scorable).toBe(true);
    expect(gem.signal).toEqual({ kind: "usage", invocations: 3, lastUsedMs: 10 });
  });

  it("maps subagents group to type subagent, scorable true", () => {
    const [gem] = toUnifiedGems({
      workflows: [],
      inventory: inventoryGroups({ subagents: [{ name: "reviewer", invocations: 0, lastUsedMs: null }] }),
      miniapps: [],
    });
    expect(gem.type).toBe("subagent");
    expect(gem.scorable).toBe(true);
  });

  it("maps rubrics group to type rubric, scorable false", () => {
    const [gem] = toUnifiedGems({
      workflows: [],
      inventory: inventoryGroups({ rubrics: [{ name: "team-hygiene", invocations: 0, lastUsedMs: null }] }),
      miniapps: [],
    });
    expect(gem.type).toBe("rubric");
    expect(gem.scorable).toBe(false);
  });

  it("maps instructions group to type lesson, scorable false", () => {
    const [gem] = toUnifiedGems({
      workflows: [],
      inventory: inventoryGroups({ instructions: [{ name: "onboarding", invocations: 0, lastUsedMs: null }] }),
      miniapps: [],
    });
    expect(gem.type).toBe("lesson");
    expect(gem.scorable).toBe(false);
  });

  it("EXCLUDES mcpServers and hooks entirely", () => {
    const gems = toUnifiedGems({
      workflows: [],
      inventory: inventoryGroups({
        mcpServers: [{ name: "github", invocations: 9, lastUsedMs: 5 }],
        hooks: [{ name: "pre-commit", invocations: 1, lastUsedMs: 1 }],
      }),
      miniapps: [],
    });
    expect(gems).toEqual([]);
  });

  it("maturity is distilled by default, shared when publishedNames includes the name", () => {
    const gems = toUnifiedGems({
      workflows: [],
      inventory: inventoryGroups({ skills: [{ name: "pdf", invocations: 0, lastUsedMs: null }] }),
      miniapps: [],
      publishedNames: new Set(["pdf"]),
    });
    expect(gems[0].maturity).toBe("shared");
    expect(gems[0].value).toBe("worth-sharing");
  });

  it("value is battle-tested when invocations > 0 and not shared", () => {
    const gems = toUnifiedGems({
      workflows: [],
      inventory: inventoryGroups({ skills: [{ name: "pdf", invocations: 4, lastUsedMs: 10 }] }),
      miniapps: [],
    });
    expect(gems[0].value).toBe("battle-tested");
  });

  it("value is reusable when invocations is 0 and not shared", () => {
    const gems = toUnifiedGems({
      workflows: [],
      inventory: inventoryGroups({ skills: [{ name: "pdf", invocations: 0, lastUsedMs: null }] }),
      miniapps: [],
    });
    expect(gems[0].value).toBe("reusable");
  });

  it("provenance: used-in-N-sessions phrasing when invocations > 0", () => {
    const gems = toUnifiedGems({
      workflows: [],
      inventory: inventoryGroups({ skills: [{ name: "pdf", invocations: 1, lastUsedMs: 10 }] }),
      miniapps: [],
    });
    expect(gems[0].provenance).toBe("used in 1 session");
  });

  it("provenance: source phrasing when zero invocations but a source is present", () => {
    const gems = toUnifiedGems({
      workflows: [],
      inventory: inventoryGroups({ skills: [{ name: "pdf", invocations: 0, lastUsedMs: null, source: "distilled-draft" }] }),
      miniapps: [],
    });
    expect(gems[0].provenance).toBe("source: distilled-draft");
    expect(gems[0].source).toBe("distilled-draft");
  });

  it("provenance: not-yet-used phrasing when zero invocations and no source", () => {
    const gems = toUnifiedGems({
      workflows: [],
      inventory: inventoryGroups({ skills: [{ name: "pdf", invocations: 0, lastUsedMs: null }] }),
      miniapps: [],
    });
    expect(gems[0].provenance).toBe("not yet used");
  });

  it("carries title through and builds id from type:name (no root)", () => {
    const gems = toUnifiedGems({
      workflows: [],
      inventory: inventoryGroups({ rubrics: [{ name: "team-hygiene", title: "Team hygiene", invocations: 0, lastUsedMs: null }] }),
      miniapps: [],
    });
    expect(gems[0].title).toBe("Team hygiene");
    expect(gems[0].id).toBe("rubric:team-hygiene");
    expect(gems[0].root).toBeUndefined();
  });
});

describe("toUnifiedGems: miniapps", () => {
  it("maps to type miniapp, scorable false, signal genre", () => {
    const [gem] = toUnifiedGems({
      workflows: [],
      inventory: [],
      miniapps: [{ name: "wordle-clone", title: "Wordle Clone", genre: "puzzle" }],
    });
    expect(gem.type).toBe("miniapp");
    expect(gem.scorable).toBe(false);
    expect(gem.signal).toEqual({ kind: "genre", genre: "puzzle" });
    expect(gem.provenance).toBe("puzzle");
    expect(gem.title).toBe("Wordle Clone");
    expect(gem.id).toBe("miniapp:wordle-clone");
  });

  it("is distilled by default, shared + worth-sharing when published", () => {
    const notPublished = toUnifiedGems({ workflows: [], inventory: [], miniapps: [{ name: "a", title: "A", genre: "arcade" }] })[0];
    expect(notPublished.maturity).toBe("distilled");
    expect(notPublished.value).toBe("reusable");

    const published = toUnifiedGems({
      workflows: [],
      inventory: [],
      miniapps: [{ name: "a", title: "A", genre: "arcade" }],
      publishedNames: new Set(["a"]),
    })[0];
    expect(published.maturity).toBe("shared");
    expect(published.value).toBe("worth-sharing");
  });
});

describe("toUnifiedGems: ids are unique across sources", () => {
  it("does not collide between a workflow and an inventory item of the same name", () => {
    const gems = toUnifiedGems({
      workflows: [workflow({ name: "deploy", key: "deploy" })],
      inventory: inventoryGroups({ skills: [{ name: "deploy", invocations: 0, lastUsedMs: null }] }),
      miniapps: [{ name: "deploy", title: "Deploy", genre: "tool" }],
    });
    const ids = gems.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("groupGemsByType", () => {
  const gems: UnifiedGem[] = [
    { id: "1", type: "miniapp", name: "m", provenance: "", maturity: "distilled", value: "reusable", signal: { kind: "none" }, scorable: false },
    { id: "2", type: "workflow", name: "w", provenance: "", maturity: "raw", value: "reusable", signal: { kind: "none" }, scorable: true },
    { id: "3", type: "skill", name: "s", provenance: "", maturity: "distilled", value: "reusable", signal: { kind: "none" }, scorable: true },
  ];

  it("returns groups in fixed display order, omitting empty types", () => {
    const groups = groupGemsByType(gems);
    expect(groups.map((g) => g.key)).toEqual(["workflow", "skill", "miniapp"]);
    expect(groups.map((g) => g.label)).toEqual(["Workflows", "Skills", "Miniapps"]);
  });

  it("omits every type with no items", () => {
    const groups = groupGemsByType([]);
    expect(groups).toEqual([]);
  });
});

describe("groupGemsByMaturity", () => {
  const gems: UnifiedGem[] = [
    { id: "1", type: "skill", name: "a", provenance: "", maturity: "shared", value: "worth-sharing", signal: { kind: "none" }, scorable: true },
    { id: "2", type: "skill", name: "b", provenance: "", maturity: "raw", value: "reusable", signal: { kind: "none" }, scorable: true },
  ];

  it("returns groups in fixed order raw, distilled, shared with hints, omitting empties", () => {
    const groups = groupGemsByMaturity(gems);
    expect(groups.map((g) => g.key)).toEqual(["raw", "shared"]);
    expect(groups.find((g) => g.key === "raw")?.hint).toBe("detected, not yet a gem");
    expect(groups.find((g) => g.key === "shared")?.hint).toBe("published or deployed");
  });

  it("includes the distilled hint when present", () => {
    const groups = groupGemsByMaturity([
      { id: "1", type: "skill", name: "a", provenance: "", maturity: "distilled", value: "reusable", signal: { kind: "none" }, scorable: true },
    ]);
    expect(groups[0].hint).toBe("mined into a reusable gem");
  });
});

describe("groupGemsByValue", () => {
  const gems: UnifiedGem[] = [
    { id: "1", type: "skill", name: "a", provenance: "", maturity: "distilled", value: "reusable", signal: { kind: "none" }, scorable: true },
    { id: "2", type: "skill", name: "b", provenance: "", maturity: "shared", value: "worth-sharing", signal: { kind: "none" }, scorable: true },
    { id: "3", type: "skill", name: "c", provenance: "", maturity: "distilled", value: "battle-tested", signal: { kind: "none" }, scorable: true },
  ];

  it("returns groups in fixed order and reuses PR-1's labels/hints", () => {
    const groups = groupGemsByValue(gems, []);
    expect(groups.map((g) => g.key)).toEqual(["battle-tested", "worth-sharing", "reusable"]);
    const battleTested = groups.find((g) => g.key === "battle-tested");
    expect(battleTested?.label).toBe("Battle-tested");
    expect(battleTested?.hint).toBe("proven across many sessions");
    const worthSharing = groups.find((g) => g.key === "worth-sharing");
    expect(worthSharing?.label).toBe("Worth sharing");
    expect(worthSharing?.hint).toBe("portable, no local coupling");
    const reusable = groups.find((g) => g.key === "reusable");
    expect(reusable?.label).toBe("Reusable");
    expect(reusable?.hint).toBe("detected, not yet battle-tested");
  });

  it("appends a gaps group from the passed strings, with PR-1's label/hint", () => {
    const groups = groupGemsByValue(gems, ["repeated manual deploys"]);
    const gaps = groups[groups.length - 1];
    expect(gaps.key).toBe("gaps");
    expect(gaps.label).toBe("Gaps");
    expect(gaps.hint).toBe("recurring pain, not yet distilled");
    expect("gaps" in gaps ? gaps.gaps : []).toEqual(["repeated manual deploys"]);
  });

  it("omits the gaps group when gaps is empty", () => {
    const groups = groupGemsByValue(gems, []);
    expect(groups.find((g) => g.key === "gaps")).toBeUndefined();
  });

  it("omits empty value buckets", () => {
    const groups = groupGemsByValue([gems[0]], []);
    expect(groups.map((g) => g.key)).toEqual(["reusable"]);
  });
});

import type { WorkflowCardModel } from "./groupWorkflows.js";
import type { LedgerGroup } from "../shared/ledgerModel.js";

export type GemType = "workflow" | "skill" | "subagent" | "lesson" | "rubric" | "miniapp";
export type Maturity = "raw" | "distilled" | "shared";
export type ValueBucket = "battle-tested" | "worth-sharing" | "reusable";

export type GemSignal =
  | { kind: "confidence"; confidence: "high" | "medium" | "low"; portable: boolean }
  | { kind: "usage"; invocations: number; lastUsedMs: number | null }
  | { kind: "genre"; genre: string }
  | { kind: "none" };

export type UnifiedGem = {
  id: string; // stable identity
  type: GemType;
  name: string;
  title?: string;
  provenance: string;
  maturity: Maturity;
  value: ValueBucket;
  signal: GemSignal;
  scorable: boolean; // true iff "Run hygiene" applies (transcript-relevant): workflow + skill + subagent
  root?: string; // workflow: project root (detail/hygiene). undefined for others.
  key?: string; // workflow: workflow key.
  source?: string; // inventory source (e.g. "distilled-draft").
};

export type Miniapp = { name: string; title: string; genre: string };

// Inventory group key -> unified gem type. Groups not present here (mcpServers, hooks) are
// setup/config, not mined gems, and are excluded from the unified set entirely.
const INVENTORY_TYPE: Partial<Record<string, GemType>> = {
  skills: "skill",
  subagents: "subagent",
  rubrics: "rubric",
  instructions: "lesson",
};

const SCORABLE_INVENTORY_TYPES: ReadonlySet<GemType> = new Set(["skill", "subagent"]);

function workflowGem(w: WorkflowCardModel): UnifiedGem {
  const value: ValueBucket = w.portable ? "worth-sharing" : w.confidence === "high" ? "battle-tested" : "reusable";
  const provenance = w.sessions > 0
    ? `distilled from ${w.sessions} session${w.sessions === 1 ? "" : "s"} · ${w.projectLabel}`
    : `· ${w.projectLabel}`;
  return {
    id: `workflow:${w.root}:${w.key}`,
    type: "workflow",
    name: w.name,
    provenance,
    maturity: "raw",
    value,
    signal: { kind: "confidence", confidence: w.confidence, portable: w.portable },
    scorable: true,
    root: w.root,
    key: w.key,
  };
}

function inventoryGems(groups: LedgerGroup[], publishedNames: Set<string>): UnifiedGem[] {
  const gems: UnifiedGem[] = [];
  for (const group of groups) {
    const type = INVENTORY_TYPE[group.key];
    if (!type) continue; // mcpServers, hooks: not mined gems
    for (const item of group.items) {
      const maturity: Maturity = publishedNames.has(item.name) ? "shared" : "distilled";
      const value: ValueBucket = maturity === "shared"
        ? "worth-sharing"
        : item.invocations > 0
        ? "battle-tested"
        : "reusable";
      const provenance = item.invocations > 0
        ? `used in ${item.invocations} session${item.invocations === 1 ? "" : "s"}`
        : item.source
        ? `source: ${item.source}`
        : "not yet used";
      gems.push({
        id: `${type}:${item.name}`,
        type,
        name: item.name,
        title: item.title,
        provenance,
        maturity,
        value,
        signal: { kind: "usage", invocations: item.invocations, lastUsedMs: item.lastUsedMs },
        scorable: SCORABLE_INVENTORY_TYPES.has(type),
        source: item.source,
      });
    }
  }
  return gems;
}

function miniappGem(m: Miniapp, publishedNames: Set<string>): UnifiedGem {
  const maturity: Maturity = publishedNames.has(m.name) ? "shared" : "distilled";
  return {
    id: `miniapp:${m.name}`,
    type: "miniapp",
    name: m.name,
    title: m.title,
    provenance: m.genre,
    maturity,
    value: maturity === "shared" ? "worth-sharing" : "reusable",
    signal: { kind: "genre", genre: m.genre },
    scorable: false,
  };
}

export function toUnifiedGems(input: {
  workflows: WorkflowCardModel[];
  inventory: LedgerGroup[];
  miniapps: Miniapp[];
  publishedNames?: Set<string>;
}): UnifiedGem[] {
  const publishedNames = input.publishedNames ?? new Set<string>();
  return [
    ...input.workflows.map(workflowGem),
    ...inventoryGems(input.inventory, publishedNames),
    ...input.miniapps.map((m) => miniappGem(m, publishedNames)),
  ];
}

const TYPE_ORDER: { key: GemType; label: string }[] = [
  { key: "workflow", label: "Workflows" },
  { key: "skill", label: "Skills" },
  { key: "subagent", label: "Subagents" },
  { key: "lesson", label: "Lessons" },
  { key: "rubric", label: "Rubrics" },
  { key: "miniapp", label: "Miniapps" },
];

export function groupGemsByType(gems: UnifiedGem[]): { key: GemType; label: string; items: UnifiedGem[] }[] {
  return TYPE_ORDER
    .map(({ key, label }) => ({ key, label, items: gems.filter((g) => g.type === key) }))
    .filter((g) => g.items.length > 0);
}

const MATURITY_ORDER: { key: Maturity; label: string; hint: string }[] = [
  { key: "raw", label: "Raw", hint: "detected, not yet a gem" },
  { key: "distilled", label: "Distilled", hint: "mined into a reusable gem" },
  { key: "shared", label: "Shared", hint: "published or deployed" },
];

export function groupGemsByMaturity(gems: UnifiedGem[]): { key: Maturity; label: string; hint: string; items: UnifiedGem[] }[] {
  return MATURITY_ORDER
    .map(({ key, label, hint }) => ({ key, label, hint, items: gems.filter((g) => g.maturity === key) }))
    .filter((g) => g.items.length > 0);
}

const VALUE_ORDER: { key: ValueBucket; label: string; hint: string }[] = [
  { key: "battle-tested", label: "Battle-tested", hint: "proven across many sessions" },
  { key: "worth-sharing", label: "Worth sharing", hint: "portable, no local coupling" },
  { key: "reusable", label: "Reusable", hint: "detected, not yet battle-tested" },
];

export function groupGemsByValue(gems: UnifiedGem[], gaps: string[]): (
  | { key: ValueBucket; label: string; hint: string; items: UnifiedGem[] }
  | { key: "gaps"; label: string; hint: string; gaps: string[] }
)[] {
  const groups: (
    | { key: ValueBucket; label: string; hint: string; items: UnifiedGem[] }
    | { key: "gaps"; label: string; hint: string; gaps: string[] }
  )[] = VALUE_ORDER
    .map(({ key, label, hint }) => ({ key, label, hint, items: gems.filter((g) => g.value === key) }))
    .filter((g) => g.items.length > 0);
  if (gaps.length) groups.push({ key: "gaps", label: "Gaps", hint: "recurring pain, not yet distilled", gaps });
  return groups;
}

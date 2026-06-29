// src/gem/optimizeAnalyze.ts
//
// Pure (no IO) payload builder for GET /api/optimize. Joins the installed inventory
// with per-artifact usage to flag installed-but-unused skills/MCP, and derives a
// deterministic weight/health view of instructions (CLAUDE.md / AGENTS.md).
import type { ConfigInventory, McpServerArtifact, SkillArtifact } from "./types.js";
import type { ArtifactUsage } from "./workflowScan.js";

export type OptimizeRange = "today" | "7d" | "30d" | "all";

export interface OptimizeArtifact {
  name: string;
  type: "skill" | "mcp";
  source: string;
  contextTokens: number;          // estimate (chars/4)
  uses: number;                   // all-time invocations
  lastUsedMs: number | null;
  prune: boolean;                 // not used within the range
  change: { file: string; key: string };  // reversible deactivation hint
}

export interface OptimizeInstruction {
  name: string;
  source: string;
  contextTokens: number;          // estimate, loaded every session
  lines: number;
  flags: ("oversized" | "very-long" | "duplicate-lines")[];
}

export interface OptimizePayload {
  range: OptimizeRange;
  artifacts: OptimizeArtifact[];
  instructions: OptimizeInstruction[];
}

const DAY = 86_400_000;
const OVERSIZED_TOKENS = 2000;
const VERY_LONG_LINES = 300;
const DUP_LINE_MIN = 5;

export function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function rangeStartMs(range: OptimizeRange, nowMs: number): number {
  switch (range) {
    case "all": return 0;
    case "today": return nowMs - DAY;
    case "7d": return nowMs - 7 * DAY;
    case "30d": return nowMs - 30 * DAY;
  }
}

// "plugin:brooks-lint" -> "brooks-lint"; anything else -> null.
function pluginKey(source: string): string | null {
  return source.startsWith("plugin:") ? source.slice("plugin:".length) : null;
}

function skillContextTokens(s: SkillArtifact): number {
  return estTokens(`${s.name}\n${s.description ?? ""}`);
}

// MCP tool schemas are injected at runtime and not knowable statically; estimate from
// the launch config as a floor (UI labels it "+ tool schemas at runtime").
function mcpContextTokens(m: McpServerArtifact): number {
  return estTokens(JSON.stringify(m.config));
}

function changeHint(type: "skill" | "mcp", name: string, source: string): { file: string; key: string } {
  const plugin = pluginKey(source);
  if (plugin) return { file: "settings.json", key: `enabledPlugins["${plugin}"] = false` };
  if (type === "skill") {
    if (source === "codex") return { file: "filesystem", key: `~/.codex/skills/${name} (move/remove)` };
    return { file: "settings.json", key: `skillOverrides["${name}"] = "off"` };
  }
  // mcp
  if (source === "codex") return { file: "~/.codex/config.toml", key: `set enabled = false for ${name}` };
  return { file: "settings.json", key: `mcpServers.${name} (remove, or add to deniedMcpServers)` };
}

function buildArtifacts(inv: ConfigInventory, usage: Map<string, ArtifactUsage>, range: OptimizeRange, nowMs: number): OptimizeArtifact[] {
  const cutoff = rangeStartMs(range, nowMs);
  const out: OptimizeArtifact[] = [];

  const push = (type: "skill" | "mcp", name: string, source: string, contextTokens: number, key: string) => {
    const u = usage.get(key);
    const uses = u?.invocations ?? 0;
    const lastUsedMs = u?.lastUsedMs ?? null;
    const prune = lastUsedMs === null || lastUsedMs < cutoff;
    out.push({ name, type, source, contextTokens, uses, lastUsedMs, prune, change: changeHint(type, name, source) });
  };

  for (const s of inv.skills) push("skill", s.name, s.source, skillContextTokens(s), `skill:${s.name}`);
  for (const m of inv.mcpServers) push("mcp", m.name, m.source ?? "user", mcpContextTokens(m), `mcp_server:${m.name}`);

  // Collapse all unused artifacts of one plugin into the single biggest-saving row, so
  // we don't tell the user to disable the same plugin five times.
  const byPlugin = new Map<string, OptimizeArtifact[]>();
  const kept: OptimizeArtifact[] = [];
  for (const a of out) {
    const plugin = pluginKey(a.source);
    if (plugin && a.prune) {
      const arr = byPlugin.get(plugin) ?? [];
      arr.push(a);
      byPlugin.set(plugin, arr);
    } else {
      kept.push(a);
    }
  }
  for (const arr of byPlugin.values()) {
    arr.sort((x, y) => y.contextTokens - x.contextTokens);
    kept.push(arr[0]);
  }
  return kept.sort((a, b) => b.contextTokens - a.contextTokens);
}

function instructionHealth(name: string, source: string, content: string): OptimizeInstruction {
  const lines = content.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const contextTokens = estTokens(content);
  const counts = new Map<string, number>();
  for (const l of nonEmpty) {
    const t = l.trim();
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const dupTotal = [...counts.values()].filter((n) => n > 1).reduce((acc, n) => acc + n, 0);
  const flags: OptimizeInstruction["flags"] = [];
  if (contextTokens > OVERSIZED_TOKENS) flags.push("oversized");
  if (nonEmpty.length > VERY_LONG_LINES) flags.push("very-long");
  if (dupTotal >= DUP_LINE_MIN) flags.push("duplicate-lines");
  return { name, source, contextTokens, lines: nonEmpty.length, flags };
}

function buildInstructions(inv: ConfigInventory): OptimizeInstruction[] {
  const out: OptimizeInstruction[] = [];
  for (const i of inv.instructions) out.push(instructionHealth(i.name, "user", i.content));
  for (const p of inv.projects ?? []) {
    for (const i of p.instructions) out.push(instructionHealth(i.name, p.root, i.content));
  }
  return out.sort((a, b) => b.contextTokens - a.contextTokens);
}

export function buildOptimizePayload(inv: ConfigInventory, usage: Map<string, ArtifactUsage>, range: OptimizeRange, nowMs: number): OptimizePayload {
  return {
    range,
    artifacts: buildArtifacts(inv, usage, range, nowMs),
    instructions: buildInstructions(inv),
  };
}

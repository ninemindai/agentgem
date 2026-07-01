// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/buildGem.ts
import type { ConfigInventory, Gem, GemArtifact, GemCheck, SecretRequirement, ChannelPlatform } from "@agentgem/model";
import { redactMcpConfig } from "@agentgem/base";
import { makeChannelArtifact } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";

export interface ProjectSelection {
  skills?: string[];
  mcpServers?: string[];
  includeInstructions?: boolean;   // all instructions (back-compat, wins over `instructions`)
  instructions?: string[];         // a named subset (e.g. a single distilled lesson)
  hooks?: string[];
}

export type GemSelection =
  | { all: true }
  | {
      all?: false;
      skills?: string[];
      mcpServers?: string[];
      includeInstructions?: boolean;
      instructions?: string[];
      hooks?: string[];
      projects?: Record<string, ProjectSelection>; // keyed by project root path
    };

/** Resolve instruction artifacts for a selection scope: all when `includeInstructions`
 *  is set (back-compat), else the named subset (name-resolved like skills/hooks). */
function selectInstructions(
  pool: ConfigInventory["instructions"],
  sel: { includeInstructions?: boolean; instructions?: string[] },
  where: string,
): ConfigInventory["instructions"] {
  if (sel.includeInstructions) return pool;
  return (sel.instructions ?? []).map((n) => {
    const a = pool.find((s) => s.name === n);
    if (!a) throw new InvalidInputError(`No instruction '${n}'${where}. Available: ${pool.map((s) => s.name).join(", ") || "(none)"}`);
    return a;
  });
}

export function buildGem(
  inventory: ConfigInventory,
  selection: GemSelection,
  opts: { name?: string; createdFrom?: string; checks?: GemCheck[]; channels?: { platform: ChannelPlatform; name?: string }[]; grade?: number } = {},
): Gem {
  const artifacts: GemArtifact[] = [];
  const projects = inventory.projects ?? [];

  if ("all" in selection && selection.all) {
    artifacts.push(...inventory.skills, ...inventory.mcpServers, ...inventory.instructions, ...inventory.hooks);
    for (const p of projects) artifacts.push(...p.skills, ...p.mcpServers, ...p.instructions, ...p.hooks);
  } else {
    const sel = selection as Exclude<GemSelection, { all: true }>;
    for (const n of sel.skills ?? []) {
      const a = inventory.skills.find((s) => s.name === n);
      if (!a) throw new InvalidInputError(`No skill '${n}'. Available: ${inventory.skills.map((s) => s.name).join(", ") || "(none)"}`);
      artifacts.push(a);
    }
    for (const n of sel.mcpServers ?? []) {
      const a = inventory.mcpServers.find((s) => s.name === n);
      if (!a) throw new InvalidInputError(`No MCP server '${n}'. Available: ${inventory.mcpServers.map((s) => s.name).join(", ") || "(none)"}`);
      artifacts.push(a);
    }
    artifacts.push(...selectInstructions(inventory.instructions, sel, ""));
    for (const n of sel.hooks ?? []) {
      const a = inventory.hooks.find((h) => h.name === n);
      if (!a) throw new InvalidInputError(`No hook '${n}'. Available: ${inventory.hooks.map((h) => h.name).join(", ") || "(none)"}`);
      artifacts.push(a);
    }
    for (const [root, ps] of Object.entries(sel.projects ?? {})) {
      const proj = projects.find((p) => p.root === root);
      if (!proj) throw new InvalidInputError(`No project '${root}'. Loaded: ${projects.map((p) => p.root).join(", ") || "(none)"}`);
      for (const n of ps.skills ?? []) {
        const a = proj.skills.find((s) => s.name === n);
        if (!a) throw new InvalidInputError(`No skill '${n}' in project '${proj.name}'. Available: ${proj.skills.map((s) => s.name).join(", ") || "(none)"}`);
        artifacts.push(a);
      }
      for (const n of ps.mcpServers ?? []) {
        const a = proj.mcpServers.find((s) => s.name === n);
        if (!a) throw new InvalidInputError(`No MCP server '${n}' in project '${proj.name}'. Available: ${proj.mcpServers.map((s) => s.name).join(", ") || "(none)"}`);
        artifacts.push(a);
      }
      artifacts.push(...selectInstructions(proj.instructions, ps, ` in project '${proj.name}'`));
      for (const n of ps.hooks ?? []) {
        const a = proj.hooks.find((h) => h.name === n);
        if (!a) throw new InvalidInputError(`No hook '${n}' in project '${proj.name}'. Available: ${proj.hooks.map((h) => h.name).join(", ") || "(none)"}`);
        artifacts.push(a);
      }
    }
  }

  // Defense in depth: an mcp/hook artifact missing `secretRefs` was never redacted (e.g. it came
  // from introspectConfig({redact:false}), which the import path uses). Re-redact it before it can
  // enter the gem. Already-redacted artifacts carry a secretRefs array (possibly empty) and are
  // left untouched, so this never double-redacts or corrupts existing refs.
  const guarded = artifacts.map((a) => {
    if ((a.type === "mcp_server" || a.type === "hook") && a.secretRefs === undefined) {
      const { config, secrets } = redactMcpConfig(a.config);
      return { ...a, config, secretRefs: secrets };
    }
    return a;
  });
  artifacts.length = 0;
  artifacts.push(...guarded);
  for (const ch of opts.channels ?? []) artifacts.push(makeChannelArtifact(ch.platform, ch.name));

  const requiredSecrets: SecretRequirement[] = [];
  for (const a of artifacts) {
    if ((a.type === "mcp_server" || a.type === "hook" || a.type === "channel") && a.secretRefs) {
      for (const ref of a.secretRefs) requiredSecrets.push({ name: ref.name, artifact: a.name, location: ref.location });
    }
  }

  // Embed operator checks, but run each through redaction first: a check's task/setup is
  // operator-authored test data and must not smuggle a raw secret into the shared gem.
  const checks = (opts.checks ?? []).map(
    (c) => redactMcpConfig(c as unknown as Record<string, unknown>).config as unknown as GemCheck,
  );

  return {
    name: opts.name ?? "gem",
    createdFrom: opts.createdFrom ?? "unknown",
    artifacts,
    checks,
    requiredSecrets,
    ...(opts.grade != null ? { grade: opts.grade } : {}),
  };
}

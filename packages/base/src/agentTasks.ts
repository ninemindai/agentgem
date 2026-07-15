// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/base/src/agentTasks.ts
//
// Per-task-family agent/model defaults for BACKGROUND agent tasks (report render,
// distill, workflow recommender, session judge). These are formatting/summarization
// jobs, not deep reasoning, so they default to a fast model instead of inheriting
// the user's heavy interactive default (issue #430). The model rides on the
// descriptor's env overlay as ANTHROPIC_MODEL — claude-agent-acp treats that env
// var as its highest-priority model preference, and spawnEnv (acpSession.ts)
// already applies descriptor.env while re-stripping credential vars.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { AGENTS } from "./agents.js";
import type { AgentDescriptor } from "./acpSession.js";

export const AGENT_TASK_FAMILIES = ["report", "distill", "recommend", "judge"] as const;
export type AgentTaskFamily = (typeof AGENT_TASK_FAMILIES)[number];

export interface AgentTaskPref { agent?: string; model?: string }
export type AgentTaskPrefs = Partial<Record<AgentTaskFamily, AgentTaskPref>>;

// Fast default: measured ~2.3× faster than a large interactive default on the
// report-render path (#430). Any model string the adapter can resolve is valid here.
export const FAST_MODEL = "claude-haiku-4-5";
// Sentinel: no ANTHROPIC_MODEL overlay — the task inherits the user's interactive default.
export const INHERIT_MODEL = "default";

export function agentTasksPath(base = agentgemHome()): string {
  return join(base, ".agentgem", "agent-tasks.json");
}

export function loadAgentTaskPrefs(base = agentgemHome()): AgentTaskPrefs {
  const p = agentTasksPath(base);
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as AgentTaskPrefs) : {};
  } catch {
    return {};
  }
}

export function saveAgentTaskPref(family: AgentTaskFamily, pref: AgentTaskPref, base = agentgemHome()): void {
  const p = agentTasksPath(base);
  mkdirSync(dirname(p), { recursive: true });
  const all = loadAgentTaskPrefs(base);
  all[family] = pref;
  writeFileSync(p, JSON.stringify(all, null, 2), { mode: 0o600 });
}

/** Prefs with defaults filled in for every family — what the Settings UI renders. */
export function effectiveAgentTaskPrefs(prefs: AgentTaskPrefs = loadAgentTaskPrefs()): Record<AgentTaskFamily, Required<AgentTaskPref>> {
  const out = {} as Record<AgentTaskFamily, Required<AgentTaskPref>>;
  for (const f of AGENT_TASK_FAMILIES) {
    out[f] = { agent: prefs[f]?.agent ?? "claude-code", model: prefs[f]?.model ?? FAST_MODEL };
  }
  return out;
}

/**
 * Resolve the descriptor a background task family should spawn. Unknown agent ids
 * fall back to claude-code; the model overlay applies only to claude-code (codex-acp
 * has no verified model env) and is skipped for the INHERIT_MODEL sentinel.
 */
export function taskAgent(family: AgentTaskFamily, prefs: AgentTaskPrefs = loadAgentTaskPrefs()): AgentDescriptor {
  const pref = prefs[family] ?? {};
  const base = AGENTS.find((a) => a.id === pref.agent) ?? AGENTS.find((a) => a.id === "claude-code")!;
  const model = pref.model ?? FAST_MODEL;
  if (base.id !== "claude-code" || model === INHERIT_MODEL) return { ...base };
  return { ...base, env: { ...base.env, ANTHROPIC_MODEL: model } };
}

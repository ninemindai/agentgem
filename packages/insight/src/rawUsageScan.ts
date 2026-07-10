// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/rawUsageScan.ts
//
// One transcript file -> its usage contribution, split by what determines it.
//
//  - skills and mcp servers are TOKEN-DRIVEN: the transcript carries the token
//    (`Skill(superpowers:brainstorming)`, `mcp__ctx7__query-docs`). The inventory only decides
//    what that token RESOLVES to. So the token is stored raw, and resolution happens at query
//    time — which is why installing a skill no longer invalidates a single parsed file.
//
//  - hooks are INVENTORY-DRIVEN: a hook has no token. You can only tell one fired by searching
//    each record for THAT hook's own event name and command basename, both read from the
//    inventory's `config`. So hook hits are resolved here, at parse time, and a hook change
//    still forces a reparse. That asymmetry is the whole reason `hook_digest` survives.
//
// Mirrors scanWorkflow's detection exactly (assistant-only tool_use, the Skill/mcp__ dispatch,
// the hook-signal heuristic). scanWorkflow remains the source of truth for everything else;
// a differential test pins this function's output to it.
//
// Diagram maintenance is part of the change: if a future edit adds a fifth invalidation
// trigger or a new token kind, update the diagram below in the same commit.
//
//   one transcript record ─┬─ assistant tool_use "Skill"     → raw skill token   (inventory-independent)
//                          ├─ assistant tool_use "mcp__x__y" → raw mcp token      (inventory-independent)
//                          └─ any record matching /Hook\b/    → hook hit, matched
//                                                               by THIS hook's event/cmd (needs inventory)
import { readFileSync } from "node:fs";
import type { HookArtifact } from "@agentgem/model";
import { mcpServerToken, firstHookCommand } from "./workflowScan.js";

export interface RawUsageRow { kind: "skill" | "mcp_server"; token: string; invocations: number }
export interface HookUsageRow { name: string; invocations: number }
export interface FileUsage { raw: RawUsageRow[]; hooks: HookUsageRow[]; failed?: boolean }

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export function scanFileUsage(path: string, hooks: HookArtifact[]): FileUsage {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return { raw: [], hooks: [], failed: true }; }

  const rawCount = new Map<string, number>();   // `${kind} ${token}`
  const hookCount = new Map<string, number>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; } // a corrupt line contributes nothing
    const r = rec as { message?: { role?: string; content?: unknown }; role?: string };

    // Only ASSISTANT messages carry real tool_use invocations. The system-prompt tool
    // catalog also lists mcp__ names but is not an assistant message — availability, not usage.
    const role = r?.message?.role ?? r?.role;
    const content = r?.message?.content;
    if (role === "assistant" && Array.isArray(content)) {
      for (const block of content as { type?: string; name?: string; input?: { skill?: unknown } }[]) {
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        const name = block.name;
        if (name === "Skill" && typeof block.input?.skill === "string") bump(rawCount, `skill ${block.input.skill}`);
        else if (name.startsWith("mcp__")) bump(rawCount, `mcp_server ${mcpServerToken(name)}`);
      }
    }

    // Hook firing is low-confidence: hooks aren't tool_use, they surface as injected
    // "... hook success:" / hook-event text. Match by event or command basename.
    const flat = typeof rec === "string" ? rec : JSON.stringify(rec);
    if (flat.includes("hook success") || /Hook\b/.test(flat)) {
      for (const h of hooks) {
        const cmd = firstHookCommand(h.config);
        const base = cmd ? cmd.split("/").pop()! : "";
        if ((h.event && flat.includes(h.event)) || (base && flat.includes(base))) bump(hookCount, h.name);
      }
    }
  }

  const raw: RawUsageRow[] = [...rawCount.entries()].map(([key, invocations]) => {
    const sep = key.indexOf(" ");
    return { kind: key.slice(0, sep) as RawUsageRow["kind"], token: key.slice(sep + 1), invocations };
  });
  return { raw, hooks: [...hookCount.entries()].map(([name, invocations]) => ({ name, invocations })) };
}

// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/draftGem.ts
//
// Draft-a-Gem handoff: ask the live chat session for a selection JSON,
// validate names against the local ConfigInventory, build the Gem, and
// return { selection, gem, dropped } to the caller.
//
// NOTE: There is no persistent "Curate draft store" in this repo.
//       The route returns the built Gem directly to the client.
//       A future Curate deep-link integration can persist the result via
//       a separate store once that store exists.
import type { ConfigInventory, Gem } from "@agentgem/model";
import type { GemSelection } from "@agentgem/build";
import { buildGem } from "@agentgem/build";
import type { ChatEvent } from "@agentgem/run";
import { createLogger } from "@agentgem/base";

const log = createLogger("goldmine");

// ── validateSelection ────────────────────────────────────────────────────────

/**
 * Filter a raw agent-proposed selection against the actual ConfigInventory.
 * Any artifact name that is not present in the inventory is silently dropped.
 * Returns {} when nothing valid remains or when the input is malformed.
 */
export function validateSelection(raw: unknown, inv: ConfigInventory): Exclude<GemSelection, { all: true }> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;

  const keep = (pool: { name: string }[], names: unknown): string[] => {
    if (!Array.isArray(names)) return [];
    return names.filter((n): n is string => typeof n === "string" && pool.some((a) => a.name === n));
  };

  const sel: Exclude<GemSelection, { all: true }> = {};
  const skills = keep(inv.skills, obj.skills);
  if (skills.length) sel.skills = skills;
  const mcpServers = keep(inv.mcpServers, obj.mcpServers);
  if (mcpServers.length) sel.mcpServers = mcpServers;
  const hooks = keep(inv.hooks, obj.hooks);
  if (hooks.length) sel.hooks = hooks;
  return sel;
}

// ── Prompt sent to the live chat session ─────────────────────────────────────

const DRAFT_PROMPT = `
Review our conversation and identify which installed Claude Code artifacts are worth bundling into a reusable Gem.

Respond with ONLY a JSON object — no prose, no markdown fences, no extra keys:
{"skills":[],"mcpServers":[],"hooks":[]}

Each value is an array of INSTALLED artifact names (exactly as they appear in your tools).
List only artifacts that are genuinely relevant to the workflows we discussed.
If none are relevant, return an empty object {}.
`.trim();

// ── Deps seam ─────────────────────────────────────────────────────────────────

export interface DraftGemDeps {
  manager: {
    sendMessage(chatId: string, message: string): AsyncGenerator<ChatEvent>;
  };
  /** Override for tests; defaults to `introspectConfig` from @agentgem/capture */
  introspect?: () => ConfigInventory;
}

// ── extractFirstJson ─────────────────────────────────────────────────────────

/** Extract the first {...} block from a string (first-brace / last-brace slice). */
function extractFirstJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    log.warn("extractFirstJson parse failed: %s", (err as Error)?.message ?? err);
    return null;
  }
}

// ── draftGemFromChat ─────────────────────────────────────────────────────────

export type DraftGemResult =
  | { selection: Exclude<GemSelection, { all: true }>; gem: Gem; dropped: string[] }
  | { error: string };

/**
 * Drive one selection turn on the live chat session and build a Gem from it.
 *
 * 1. Send a strict JSON-only prompt via deps.manager.sendMessage.
 * 2. Consume the async generator; accumulate text from "done" event.
 *    Return { error } if a "failed" event arrives first.
 * 3. Extract first {...} JSON block from the response text.
 * 4. validateSelection against ConfigInventory from introspectConfig().
 * 5. buildGem(inv, selection) and compute dropped = hallucinated names.
 * 6. Never throw — all errors are returned as { error: string }.
 */
export async function draftGemFromChat(
  deps: DraftGemDeps,
  chatId: string,
): Promise<DraftGemResult> {
  try {
    // Step 1+2: consume the generator
    let doneText: string | null = null;
    for await (const ev of deps.manager.sendMessage(chatId, DRAFT_PROMPT)) {
      if (ev.type === "failed") {
        return { error: ev.error };
      }
      if (ev.type === "done") {
        doneText = ev.result.text;
        break;
      }
    }

    if (doneText === null) {
      return { error: "chat session ended without a done event" };
    }

    // Step 3: extract JSON
    const parsed = extractFirstJson(doneText);
    if (parsed === null) {
      return { error: "no JSON block found in agent response" };
    }

    // Step 4: validate against inventory
    const introspect = deps.introspect ?? (await import("@agentgem/capture")).introspectConfig;
    const inv = introspect();
    const selection = validateSelection(parsed, inv);

    // Compute dropped: names the agent proposed that were not in inventory
    const proposed: string[] = [];
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      for (const arr of [obj.skills, obj.mcpServers, obj.hooks]) {
        if (Array.isArray(arr)) {
          for (const n of arr) {
            if (typeof n === "string") proposed.push(n);
          }
        }
      }
    }
    const kept = new Set([
      ...(selection.skills ?? []),
      ...(selection.mcpServers ?? []),
      ...(selection.hooks ?? []),
    ]);
    const dropped = proposed.filter((n) => !kept.has(n));

    // Step 5: build the gem
    const gem = buildGem(inv, selection);

    return { selection, gem, dropped };
  } catch (e) {
    return { error: (e as Error).message ?? String(e) };
  }
}

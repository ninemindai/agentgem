// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/inspectSession.ts
//
// On-demand, scrubbed transcript read path for the Inspect drill-down (the
// per-session viewer). Sibling to observeScan.ts: that one folds a transcript
// into a single metadata SessionStat and NEVER keeps text; this one emits an
// ordered turn -> span tree WITH content, lazily, one session at a time — never
// part of the aggregate scan, so Inspect's one-shot/metadata-only properties are
// preserved. Every content string passes through scrubText (the preserve-and-
// redact path) before it leaves here: this read path must not become the hole in
// the secret-safe boundary. Unknown record/content shapes degrade to text and
// never throw (matches observeScan's robustness contract).
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { resolveDirs } from "@agentgem/model";
import { jsonLines, listFiles, parseClaudeTranscript, parseCodexTranscript } from "./observeScan.js";
import { scrubText } from "./scrub.js";
import type { SessionStat } from "./observeAggregate.js";

export interface TokenBreakdown { in: number; out: number; cache: number; }

export type TranscriptSpan =
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "tool_call"; name: string; input: string; output?: string; error?: boolean };

export interface TranscriptTurn {
  id: string;
  role: "user" | "assistant";
  tsMs: number;
  spans: TranscriptSpan[];
  tokens: TokenBreakdown;
}

export interface TranscriptView {
  sessionId: string;
  agent: "claude" | "codex";
  meta: SessionStat;
  turns: TranscriptTurn[];
}

// Verbatim-but-bounded: a single Read of a huge file would otherwise ship
// megabytes per open (no cache, scrub-on-read). Cap each content string and mark
// the cut so truncation is visible, not silent. Virtualization/lazy expansion is
// a later phase (proposal open question); this is the v1 safety valve.
const MAX_STR = 50_000;

/** Scrub a content value to a secret-safe string. Objects are pretty-printed
 *  first so every nested string is covered by one scrubText pass. */
function scrubContent(value: unknown): string {
  const raw = typeof value === "string" ? value : safeJson(value);
  const scrubbed = scrubText(raw);
  return scrubbed.length > MAX_STR ? scrubbed.slice(0, MAX_STR) + "\n…(truncated)" : scrubbed;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}

const NO_TOKENS: TokenBreakdown = { in: 0, out: 0, cache: 0 };

function usageOf(usage: Record<string, number> | undefined): TokenBreakdown {
  if (!usage) return NO_TOKENS;
  return {
    in: usage.input_tokens ?? 0,
    out: usage.output_tokens ?? 0,
    cache: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
  };
}

// Flatten a tool_result `content` (string | array of {text} items) to one string.
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof (c as Record<string, unknown>).text === "string"
      ? (c as Record<string, string>).text : "")).filter(Boolean).join("\n");
  }
  return content == null ? "" : safeJson(content);
}

export function parseClaudeTranscriptView(text: string, path: string): TranscriptView | null {
  const meta = parseClaudeTranscript(text, path);
  if (!meta) return null;
  const records = [...jsonLines(text)];

  // Pass 1: index tool outputs by tool_use_id so they pair onto the assistant's
  // tool_use span instead of surfacing as their own (duplicate) user turns.
  const outputs = new Map<string, { text: string; error: boolean }>();
  for (const rec of records) {
    const content = (rec.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const it = item as Record<string, unknown>;
      if (it.type === "tool_result" && typeof it.tool_use_id === "string") {
        outputs.set(it.tool_use_id, { text: resultText(it.content), error: it.is_error === true });
      }
    }
  }

  // Pass 2: build turns.
  const turns: TranscriptTurn[] = [];
  let i = 0;
  for (const rec of records) {
    const role = rec.type === "user" ? "user" : rec.type === "assistant" ? "assistant" : null;
    if (!role) continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    const tsMs = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    const spans: TranscriptSpan[] = [];

    const content = msg?.content;
    if (typeof content === "string") {
      if (content.trim()) spans.push({ kind: "message", role, text: scrubContent(content) });
    } else if (Array.isArray(content)) {
      for (const item of content) {
        const it = item as Record<string, unknown>;
        if (it.type === "text" && typeof it.text === "string") {
          if (it.text.trim()) spans.push({ kind: "message", role, text: scrubContent(it.text) });
        } else if (it.type === "thinking" && typeof it.thinking === "string") {
          if (it.thinking.trim()) spans.push({ kind: "message", role, text: scrubContent(it.thinking) });
        } else if (it.type === "tool_use" && typeof it.name === "string") {
          const out = typeof it.id === "string" ? outputs.get(it.id) : undefined;
          spans.push({
            kind: "tool_call", name: it.name, input: scrubContent(it.input),
            ...(out ? { output: scrubContent(out.text), error: out.error } : {}),
          });
        }
        // tool_result items are folded into tool_use spans (pass 1) — skip here.
        // Unknown item types degrade to a text span if they carry one.
        else if (typeof it.text === "string" && it.text.trim()) {
          spans.push({ kind: "message", role, text: scrubContent(it.text) });
        }
      }
    }

    if (!spans.length) continue;
    const id = typeof rec.uuid === "string" ? rec.uuid : `${meta.sessionId}-${i++}`;
    turns.push({ id, role, tsMs: Number.isNaN(tsMs) ? meta.startMs : tsMs, spans, tokens: usageOf(msg?.usage as Record<string, number> | undefined) });
  }

  return { sessionId: meta.sessionId, agent: "claude", meta, turns };
}

export function parseCodexTranscriptView(text: string, path: string): TranscriptView | null {
  const meta = parseCodexTranscript(text, path);
  if (!meta) return null;
  const records = [...jsonLines(text)];

  // Pass 1: index function_call_output by call_id.
  const outputs = new Map<string, string>();
  for (const rec of records) {
    const p = rec.payload as Record<string, unknown> | undefined;
    if (p?.type === "function_call_output" && typeof p.call_id === "string") {
      outputs.set(p.call_id, resultText((p.output as Record<string, unknown>)?.content ?? p.output));
    }
  }

  const turns: TranscriptTurn[] = [];
  let i = 0;
  for (const rec of records) {
    if (rec.type !== "response_item") continue;
    const p = rec.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    const tsMs = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    const spans: TranscriptSpan[] = [];
    let role: "user" | "assistant" = "assistant";

    if (p.type === "message") {
      role = p.role === "user" ? "user" : "assistant";
      const txt = codexText(p.content);
      if (txt.trim()) spans.push({ kind: "message", role, text: scrubContent(txt) });
    } else if (p.type === "reasoning") {
      const txt = codexText(p.summary ?? p.content);
      if (txt.trim()) spans.push({ kind: "message", role: "assistant", text: scrubContent(txt) });
    } else if (p.type === "function_call" && typeof p.name === "string") {
      const out = typeof p.call_id === "string" ? outputs.get(p.call_id) : undefined;
      spans.push({
        kind: "tool_call", name: p.name, input: scrubContent(p.arguments),
        ...(out !== undefined ? { output: scrubContent(out) } : {}),
      });
    }
    // function_call_output folded in pass 1; unknown types skipped.

    if (!spans.length) continue;
    const id = typeof p.id === "string" ? p.id : `${meta.sessionId}-${i++}`;
    turns.push({ id, role, tsMs: Number.isNaN(tsMs) ? meta.startMs : tsMs, spans, tokens: NO_TOKENS });
  }

  return { sessionId: meta.sessionId, agent: "codex", meta, turns };
}

// Codex message content is an array of {type:"input_text"|"output_text"|"text", text}.
function codexText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      const it = c as Record<string, unknown>;
      return typeof it?.text === "string" ? it.text : "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

/** Load + parse + scrub one session's transcript on demand. Resolves the file by
 *  id within the requested agent's store; returns null if not found or empty.
 *  Never throws — unreadable files / malformed lines degrade to null/skip. */
export async function loadSessionTranscript(
  sessionId: string,
  agent: "claude" | "codex",
  dirs?: { claudeDir?: string; codexDir?: string },
): Promise<TranscriptView | null> {
  const resolved = resolveDirs();
  if (agent === "claude") {
    // The transcript filename IS the sessionId (observeScan Fix 1).
    const claudeDir = dirs?.claudeDir ?? resolved.claudeDir;
    for (const f of listFiles(join(claudeDir, "projects"), ".jsonl")) {
      if (basename(f).replace(/\.jsonl$/, "") !== sessionId) continue;
      let raw: string; try { raw = await readFile(f, "utf8"); } catch { return null; }
      return parseClaudeTranscriptView(raw, f);
    }
    return null;
  }
  // Codex: sessionId lives in session_meta, not the rollout filename — scan and match.
  const codexDir = dirs?.codexDir ?? resolved.codexDir;
  for (const f of listFiles(join(codexDir, "sessions"), ".jsonl")) {
    if (!basename(f).startsWith("rollout-")) continue;
    let raw: string; try { raw = await readFile(f, "utf8"); } catch { continue; }
    const view = parseCodexTranscriptView(raw, f);
    if (view && view.sessionId === sessionId) return view;
  }
  return null;
}

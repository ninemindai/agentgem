// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/blastScan.ts
//
// Session blast radius: one transcript -> the ordered, scrubbed set of targets
// the session touched (project files, outside-project paths, skills, subagents,
// MCP servers, shell commands), for the Inspect → Session replay map. Standalone
// on purpose — scanWorkflow's `steps` are capped and skip Skill/mcp__ calls by
// design (see SEQ_CAP_PER_SESSION), and it is the attestation trust boundary;
// this scan is uncapped, single-file, and feeds only the UI.
//
// Zone classification runs on the RAW path against the RAW session cwd (de-homing
// would erase the prefix match); only project-relative or scrubText'd strings
// ever leave this module — same one-way boundary as resolveClaudeSession.
import { scrubStep, scrubText } from "./scrub.js";
import { mcpServerToken } from "./workflowScan.js";

export type BlastAction = "read" | "search" | "edit" | "exec" | "skill" | "agent" | "mcp" | "other";
export type BlastZone = "project" | "home" | "tmp" | "outside";

export interface BlastEvent {
  seq: number;              // 0..n over kept events
  msgIndex: number;         // JSONL line provenance
  tsMs: number | null;      // record timestamp when present
  tool: string;             // builtin name; "mcp" for mcp__* (server in target)
  action: BlastAction;
  target: string | null;    // rel path (project) | de-homed path | skill/agent/server name | bash verb
  zone?: BlastZone;         // only for path targets
  sidechain?: boolean;      // subagent activity — kept, flagged (it IS blast radius)
  error?: boolean;          // paired tool_result.is_error
}

export interface BlastReport {
  meta: { sessionId: string; transcript: string; project: string | null; startMs: number; endMs: number };
  events: BlastEvent[];
}

const READ_TOOLS = new Set(["Read"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function str(input: unknown, key: string): string {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
}

function rawPath(tool: string, input: unknown): string {
  if (EDIT_TOOLS.has(tool)) return str(input, "file_path") || str(input, "notebook_path");
  return str(input, "file_path") || str(input, "path") || str(input, "pattern");
}

// macOS tmp lives under /private/tmp and /var/folders; Linux under /tmp.
const TMP_RE = /^(\/private)?\/tmp(\/|$)|^\/var\/folders\//;

function classify(raw: string, cwd: string | null): { target: string; zone: BlastZone } {
  if (cwd && (raw === cwd || raw.startsWith(cwd.endsWith("/") ? cwd : cwd + "/"))) {
    const rel = raw.slice(cwd.length).replace(/^\//, "");
    return { target: rel || ".", zone: "project" };
  }
  if (!raw.startsWith("/")) return { target: scrubText(raw), zone: "project" }; // relative path or bare pattern
  if (TMP_RE.test(raw)) return { target: scrubText(raw), zone: "tmp" };
  const home = process.env.HOME;
  if ((home && raw.startsWith(home + "/")) || /^\/Users\/[^/]+\//.test(raw)) return { target: scrubText(raw), zone: "home" };
  return { target: scrubText(raw), zone: "outside" };
}

export interface BlastScanOptions { cwd?: string | null; sessionId?: string; transcript?: string }

/** Parse one Claude transcript's text into a BlastReport. Pure and total:
 *  unparseable lines are skipped, an empty input yields a valid zero report. */
export function scanSessionBlast(text: string, opts: BlastScanOptions = {}): BlastReport {
  const cwd = opts.cwd ?? null;
  const events: BlastEvent[] = [];
  const byToolUseId = new Map<string, BlastEvent>();
  let sessionId = opts.sessionId ?? "";
  let startMs = Infinity, endMs = 0;

  const lines = text.split("\n");
  for (let msgIndex = 0; msgIndex < lines.length; msgIndex++) {
    const line = lines[msgIndex];
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!sessionId && typeof rec?.sessionId === "string") sessionId = rec.sessionId;
    const tsMs = typeof rec?.timestamp === "string" ? Date.parse(rec.timestamp) || null : null;
    if (tsMs) { startMs = Math.min(startMs, tsMs); endMs = Math.max(endMs, tsMs); }

    const role = rec?.message?.role ?? rec?.role;
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;

    if (role === "assistant") {
      for (const block of content) {
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        const name: string = block.name;
        let action: BlastAction, target: string | null = null, zone: BlastZone | undefined;
        if (READ_TOOLS.has(name) || SEARCH_TOOLS.has(name) || EDIT_TOOLS.has(name)) {
          action = READ_TOOLS.has(name) ? "read" : SEARCH_TOOLS.has(name) ? "search" : "edit";
          const raw = rawPath(name, block.input);
          if (raw) ({ target, zone } = classify(raw, cwd));
        } else if (name === "Bash") {
          action = "exec";
          // scrubStep's coarse verb ("Bash:git commit") minus the prefix — low
          // cardinality, never the full command line.
          target = scrubStep("Bash", block.input).verb.replace(/^Bash:?/, "") || null;
        } else if (name === "Skill") {
          action = "skill";
          target = str(block.input, "skill") || str(block.input, "command") || str(block.input, "name") || null;
        } else if (name === "Task" || name === "Agent") {
          action = "agent";
          target = str(block.input, "subagent_type") || str(block.input, "subagentType") || name;
        } else if (name.startsWith("mcp__")) {
          action = "mcp";
          target = mcpServerToken(name);
        } else {
          action = "other";
        }
        const ev: BlastEvent = {
          seq: events.length, msgIndex, tsMs,
          tool: name.startsWith("mcp__") ? "mcp" : name,
          action, target,
          ...(zone ? { zone } : {}),
          ...(rec?.isSidechain ? { sidechain: true } : {}),
        };
        events.push(ev);
        if (typeof block.id === "string") byToolUseId.set(block.id, ev);
      }
    }

    // tool_result blocks live on USER records; outcome booleans only, never content.
    if (role === "user") {
      for (const block of content) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const ev = byToolUseId.get(block.tool_use_id);
        if (ev && block.is_error === true) ev.error = true;
      }
    }
  }

  return {
    meta: {
      sessionId,
      transcript: opts.transcript ?? "",
      project: cwd ? scrubText(cwd) : null,
      startMs: startMs === Infinity ? 0 : startMs,
      endMs,
    },
    events,
  };
}

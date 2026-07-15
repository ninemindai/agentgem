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

// ── Codex rollouts ───────────────────────────────────────────────────────────
// Codex has no typed Read/Edit tools — everything goes through exec_command (or
// the older `shell`) plus apply_patch, so actions come from command SEMANTICS
// (mindwalk's approach): reading commands → read, searching commands → search,
// apply_patch file headers → edit, spawn_agent → agent, the rest → exec.
const READ_CMDS = new Set(["cat", "head", "tail", "less", "more", "bat", "sed", "wc"]);
const SEARCH_CMDS = new Set(["rg", "grep", "find", "fd", "ls", "tree", "glob"]);
const MAX_CMD_TARGETS = 3;

// Path-looking tokens of a shell command: absolute, homed, or slashed relative —
// never flags, and never glob/regex arguments (rg -g '!**/dist/**', sed
// expressions, redirections), which contain a slash but aren't files.
function commandPaths(cmd: string): string[] {
  const out: string[] = [];
  for (const raw of cmd.split(/\s+/).slice(1)) {
    const tok = raw.replace(/^['"]|['"]$/g, "");
    if (!tok || tok.startsWith("-")) continue;
    if (/[*?[\]()|!^$"'{}<>]/.test(tok)) continue;   // glob/regex/redirection noise
    if (tok.startsWith("/") || tok.startsWith("~/") || (tok.includes("/") && !tok.includes("://"))) out.push(tok);
    if (out.length >= MAX_CMD_TARGETS) break;
  }
  return out;
}

// apply_patch bodies name their files as "*** Add|Update|Delete File: <path>".
function patchPaths(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
  return out;
}

// A codex function_call's `arguments` is a JSON STRING; the command may be `cmd`
// (string) or `command` (string | argv array) depending on tool generation.
function codexCommand(args: unknown): string | null {
  if (typeof args !== "string") return null;
  try {
    const o = JSON.parse(args) as Record<string, unknown>;
    if (typeof o.cmd === "string") return o.cmd;
    if (typeof o.command === "string") return o.command;
    if (Array.isArray(o.command)) return o.command.filter((t) => typeof t === "string").join(" ");
    return null;
  } catch { return null; }
}

const EXIT_CODE_RE = /(?:exited with code|exit code)[ :]+(\d+)/i;

/** Parse one Codex rollout's text into a BlastReport. Same contract as
 *  scanSessionBlast: pure, total, only scrubbed/relative strings leave. */
export function scanCodexSessionBlast(text: string, opts: BlastScanOptions = {}): BlastReport {
  const cwd = opts.cwd ?? null;
  const events: BlastEvent[] = [];
  const byCallId = new Map<string, BlastEvent[]>();
  let sessionId = opts.sessionId ?? "";
  let startMs = Infinity, endMs = 0;

  const lines = text.split("\n");
  for (let msgIndex = 0; msgIndex < lines.length; msgIndex++) {
    const line = lines[msgIndex];
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!sessionId && rec?.type === "session_meta" && typeof rec?.payload?.id === "string") sessionId = rec.payload.id;
    const p = rec?.payload;
    if (!p || typeof p !== "object") continue;
    const tsMs = typeof rec?.timestamp === "string" ? Date.parse(rec.timestamp) || null : null;
    if (tsMs) { startMs = Math.min(startMs, tsMs); endMs = Math.max(endMs, tsMs); }

    if (rec.type === "response_item" && p.type === "function_call" && typeof p.name === "string") {
      const name: string = p.name;
      const callId = typeof p.call_id === "string" ? p.call_id : null;
      const emitted: BlastEvent[] = [];
      const push = (action: BlastAction, target: string | null, zone?: BlastZone) => {
        const ev: BlastEvent = {
          seq: events.length, msgIndex, tsMs, tool: name, action, target,
          ...(zone ? { zone } : {}),
        };
        events.push(ev); emitted.push(ev);
      };
      if (name === "exec_command" || name === "shell" || name === "local_shell") {
        const cmd = codexCommand(p.arguments);
        if (cmd) {
          const argv0 = (cmd.trim().split(/\s+/)[0]?.split("/").pop() ?? "").replace(/[;|&]+$/, "");
          const action: BlastAction = READ_CMDS.has(argv0) ? "read" : SEARCH_CMDS.has(argv0) ? "search" : "exec";
          const paths = action === "exec" ? [] : commandPaths(cmd);
          if (paths.length) for (const raw of paths) { const { target, zone } = classify(raw, cwd); push(action, target, zone); }
          else push("exec", scrubStep("Bash", { command: cmd }).verb.replace(/^Bash:?/, "") || null);
        } else push("exec", null);
      } else if (name === "apply_patch") {
        const body = typeof p.arguments === "string" ? p.arguments : "";
        const paths = patchPaths((() => { try { const o = JSON.parse(body); return typeof o.input === "string" ? o.input : body; } catch { return body; } })());
        if (paths.length) for (const raw of paths) { const { target, zone } = classify(raw, cwd); push("edit", target, zone); }
        else push("edit", null);
      } else if (name === "spawn_agent") {
        let sub = "agent";
        try { const o = JSON.parse(p.arguments as string); if (typeof o.agent_type === "string") sub = o.agent_type; } catch { /* keep default */ }
        push("agent", sub);
      } else {
        push("other", null);
      }
      if (callId && emitted.length) byCallId.set(callId, emitted);
    }

    if (rec.type === "response_item" && p.type === "function_call_output" && typeof p.call_id === "string") {
      const targets = byCallId.get(p.call_id);
      if (targets) {
        const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
        const m = EXIT_CODE_RE.exec(out.slice(0, 400));
        if (m && m[1] !== "0") for (const ev of targets) ev.error = true;
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

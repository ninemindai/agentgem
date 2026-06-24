// src/gem/workflowScan.ts
//
// Deterministic transcript → WorkflowSignal. Reads a project's Claude session
// transcripts and counts which inventory artifacts ACTUALLY fired (skills, MCP
// servers, hooks), keyed to their exact inventory names so the result binds
// straight to a GemSelection. This is the trust boundary: everything downstream
// (the ACP recommender, the UI) only ranks/explains what this produced.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactType, ProjectInventory } from "./types.js";

export interface ArtifactUsage {
  type: ArtifactType;
  name: string;
  root: string | null;        // project root this artifact belongs to (null = global)
  invocations: number;        // parsed tool_use count (0 = installed, never used)
  sessionsUsedIn: number;     // distinct sessions it fired in
  lastUsedMs: number | null;  // recency
  confidence: "high" | "low"; // skills/mcp = high; hooks/instructions = low
  evidence?: string;          // tiny excerpt for rationale display, e.g. "Skill(qa)"
}

export interface WorkflowSignal {
  root: string;
  flavor: "claude" | "codex";
  sessions: { scanned: number; firstMs: number; lastMs: number; spanDays: number };
  artifacts: ArtifactUsage[];
  unresolved: { name: string; kind: ArtifactType | "builtin"; count: number }[];
  coOccurrence: { a: string; b: string; sessions: number }[];
  notes: string[];
}

// A session's cwd never changes; read just enough lines to find it.
function sessionCwd(file: string): string | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (typeof rec.cwd === "string") return rec.cwd;
    } catch { /* skip malformed */ }
  }
  return null;
}

/**
 * Every Claude transcript whose session cwd === `cwd`. The folder-name encoding
 * under ~/.claude/projects is lossy, so we scan ALL folders and filter by the
 * real cwd parsed from each session (not by folder name).
 */
export function claudeTranscriptsForCwd(claudeDir: string, cwd: string): string[] {
  const projectsDir = join(claudeDir, "projects");
  let folders: import("node:fs").Dirent[];
  try { folders = readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const dir = join(projectsDir, folder.name);
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(dir, f);
      if (sessionCwd(path) === cwd) out.push(path);
    }
  }
  return out;
}

export function safeMtime(file: string): number {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

// "mcp__plugin_context7_context7__query-docs" -> "plugin_context7_context7"
function mcpServerToken(toolName: string): string {
  const body = toolName.slice("mcp__".length);
  const idx = body.lastIndexOf("__");
  return idx >= 0 ? body.slice(0, idx) : body;
}

// Match an inventory MCP server to a runtime server token (lossy namespacing):
// equal, or the inventory name appears as a substring of the runtime token.
function matchMcpServer(token: string, servers: { name: string }[]): string | null {
  const norm = token.toLowerCase();
  for (const s of servers) {
    const n = s.name.toLowerCase();
    if (norm === n || norm.includes(n)) return s.name;
  }
  return null;
}

function firstHookCommand(config: Record<string, unknown>): string | null {
  const hooks = (config?.hooks as Array<Record<string, unknown>>) ?? [];
  for (const h of hooks) if (typeof h.command === "string") return h.command;
  return null;
}

function bumpUnresolved(
  map: Map<string, { kind: ArtifactType | "builtin"; count: number }>,
  name: string,
  kind: ArtifactType | "builtin",
) {
  const e = map.get(name);
  if (e) e.count++; else map.set(name, { kind, count: 1 });
}

interface Acc { invocations: number; sessions: Set<string>; lastMs: number; evidence?: string }

/**
 * Scan transcripts into a WorkflowSignal. Pure of side effects, total (never
 * throws): a corrupt line is skipped + noted, a corrupt session contributes
 * nothing, and an empty path list yields a valid zero signal.
 */
export function scanWorkflow(paths: string[], inventory: ProjectInventory): WorkflowSignal {
  const used = new Map<string, { type: ArtifactType; acc: Acc }>(); // key = inventory name
  const unresolved = new Map<string, { kind: ArtifactType | "builtin"; count: number }>();
  const perSession: { ms: number; names: Set<string> }[] = [];
  const notes: string[] = [];
  let firstMs = Infinity, lastMs = 0;

  const touch = (name: string, type: ArtifactType, ms: number, sessionId: string, evidence?: string) => {
    let e = used.get(name);
    if (!e) { e = { type, acc: { invocations: 0, sessions: new Set(), lastMs: 0, evidence } }; used.set(name, e); }
    e.acc.invocations++;
    e.acc.sessions.add(sessionId);
    e.acc.lastMs = Math.max(e.acc.lastMs, ms);
  };

  for (const path of paths) {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    const ms = safeMtime(path);
    firstMs = Math.min(firstMs, ms); lastMs = Math.max(lastMs, ms);
    const sessionNames = new Set<string>();
    let bad = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { bad++; continue; }

      // Only ASSISTANT messages carry real tool_use invocations. The system-prompt
      // tool catalog also lists mcp__ names but is NOT an assistant message, so it
      // never reaches this branch — that is the availability-vs-usage guard.
      const role = rec?.message?.role ?? rec?.role;
      const content = rec?.message?.content;
      if (role === "assistant" && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
          const name: string = block.name;
          if (name === "Skill" && typeof block.input?.skill === "string") {
            const skill = block.input.skill as string;
            const match = inventory.skills.find((s) => s.name === skill || skill.endsWith(`:${s.name}`));
            if (match) { touch(match.name, "skill", ms, path, `Skill(${skill})`); sessionNames.add(match.name); }
            else bumpUnresolved(unresolved, skill, "builtin");
          } else if (name.startsWith("mcp__")) {
            const server = matchMcpServer(mcpServerToken(name), inventory.mcpServers);
            if (server) { touch(server, "mcp_server", ms, path, name); sessionNames.add(server); }
            else bumpUnresolved(unresolved, mcpServerToken(name), "mcp_server");
          } else {
            bumpUnresolved(unresolved, name, "builtin");
          }
        }
      }

      // Hook firing is low-confidence: hooks aren't tool_use, they surface as
      // injected "... hook success:" / hook-event text. Match by event + command basename.
      const flat = typeof rec === "string" ? rec : JSON.stringify(rec);
      if (flat.includes("hook success") || /Hook\b/.test(flat)) {
        for (const h of inventory.hooks) {
          const cmd = firstHookCommand(h.config);
          const base = cmd ? cmd.split("/").pop()! : "";
          if ((h.event && flat.includes(h.event)) || (base && flat.includes(base))) {
            touch(h.name, "hook", ms, path); sessionNames.add(h.name);
          }
        }
      }
    }
    if (bad) notes.push(`${bad} unparseable line(s) skipped in ${path.split("/").pop()}`);
    perSession.push({ ms, names: sessionNames });
  }

  // Assemble artifacts: every inventory item appears (0 = installed, unused).
  const artifacts: ArtifactUsage[] = [];
  const add = (type: ArtifactType, name: string, confidence: "high" | "low") => {
    const e = used.get(name);
    artifacts.push({
      type, name, root: inventory.root,
      invocations: e?.acc.invocations ?? 0,
      sessionsUsedIn: e?.acc.sessions.size ?? 0,
      lastUsedMs: e?.acc.lastMs || null,
      confidence,
      evidence: e?.acc.evidence,
    });
  };
  for (const s of inventory.skills) add("skill", s.name, "high");
  for (const m of inventory.mcpServers) add("mcp_server", m.name, "high");
  for (const h of inventory.hooks) add("hook", h.name, "low");
  // Instructions are presence-only: loaded every session, never "invoked".
  for (const ins of inventory.instructions) {
    artifacts.push({
      type: "instructions", name: ins.name, root: inventory.root,
      invocations: paths.length, sessionsUsedIn: paths.length,
      lastUsedMs: lastMs || null, confidence: "low",
    });
  }

  // Co-occurrence: count sessions in which each unordered pair both fired.
  const pairCounts = new Map<string, number>();
  for (const s of perSession) {
    const names = [...s.names].sort();
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const key = `${names[i]} ${names[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
  }
  const coOccurrence = [...pairCounts.entries()].map(([k, sessions]) => {
    const [a, b] = k.split(" ");
    return { a, b, sessions };
  });

  return {
    root: inventory.root,
    flavor: "claude",
    sessions: {
      scanned: paths.length,
      firstMs: firstMs === Infinity ? 0 : firstMs,
      lastMs,
      spanDays: lastMs && firstMs !== Infinity ? Math.round((lastMs - firstMs) / 86_400_000) : 0,
    },
    artifacts,
    unresolved: [...unresolved.entries()].map(([name, v]) => ({ name, kind: v.kind, count: v.count })),
    coOccurrence,
    notes: paths.length === 0 ? [...notes, "no transcripts found for this project"] : notes,
  };
}

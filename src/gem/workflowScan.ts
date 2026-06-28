// src/gem/workflowScan.ts
//
// Deterministic transcript → WorkflowSignal. Reads a project's Claude session
// transcripts and counts which inventory artifacts ACTUALLY fired (skills, MCP
// servers, hooks), keyed to their exact inventory names so the result binds
// straight to a GemSelection. This is the trust boundary: everything downstream
// (the ACP recommender, the UI) only ranks/explains what this produced.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactType, ProjectInventory, HookArtifact } from "./types.js";
import { scrubStep, scrubProse, type ScrubbedStep } from "./scrub.js";

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

// One captured builtin tool call: the tool name, its scrubbed { verb, arg }, and
// the JSONL line index it was parsed from (provenance coordinate).
export interface ProcedureStep extends ScrubbedStep { tool: string; msgIndex: number }
export interface MissionHint { task: string; outcome: string }
// `sessionId`/`transcript`/`atMs` are provenance coordinates: which transcript a
// run came from and when. `transcript` is a basename, never an absolute path.
export interface SessionSequence { steps: ProcedureStep[]; missionHint?: MissionHint; sessionId: string; transcript: string; atMs: number }
// A recurring procedure (verb spine), the sessions exercising it, a representative
// sample index, and ALL exercising session indices (for provenance fan-out).
export interface ProcedureGroup { key: string; verbs: string[]; sessions: number; sampleSessionIdx: number; sessionIdxs: number[] }

export interface ScanOptions {
  retainSequences?: boolean;                       // default false — selective track stays cheap
  scrub?: (tool: string, input: unknown) => ScrubbedStep;  // injected; default = scrubStep
}

export interface WorkflowSignal {
  root: string;
  flavor: "claude" | "codex";
  sessions: { scanned: number; firstMs: number; lastMs: number; spanDays: number };
  artifacts: ArtifactUsage[];
  unresolved: { name: string; kind: ArtifactType | "builtin"; count: number }[];
  coOccurrence: { a: string; b: string; sessions: number }[];
  // Distillation signal (only when retainSequences is on — undefined otherwise).
  sequences?: { root: string; sessions: SessionSequence[] };
  procedures?: ProcedureGroup[];
  // Distinct per-session artifact "shapes": the set of inventory artifacts a
  // session exercised, and how many sessions had exactly that set. These are the
  // candidate flows (e.g. {diagram, mermaid} ×20 vs {scrape, playwright} ×15).
  shapes: { artifacts: string[]; sessions: number }[];
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

/** Every Claude transcript under ~/.claude/projects, regardless of cwd. */
export function allClaudeTranscripts(claudeDir: string): string[] {
  const projectsDir = join(claudeDir, "projects");
  let folders: import("node:fs").Dirent[];
  try { folders = readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const dir = join(projectsDir, folder.name);
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) if (f.endsWith(".jsonl")) out.push(join(dir, f));
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

// Global/plugin artifacts (from introspectConfig). Only names + hook config are
// needed for resolution; usage of these produces candidate-eligible artifacts
// with root=null (the global namespace) instead of falling into `gaps`.
export interface GlobalArtifacts {
  skills: { name: string }[];
  mcpServers: { name: string }[];
  hooks: HookArtifact[];
}
export interface ScanInventory {
  project: ProjectInventory;
  global?: GlobalArtifacts;
}

/**
 * Scan transcripts into a WorkflowSignal. Pure of side effects, total (never
 * throws): a corrupt line is skipped + noted, a corrupt session contributes
 * nothing, and an empty path list yields a valid zero signal.
 *
 * Usage resolves against the project inventory first, then the global/plugin
 * inventory. Project artifacts are namespaced by `root`; global ones by `null`.
 */
const SEQ_CAP_PER_SESSION = 40;
const PROCEDURES_CAP = 25;
// Recurrence is mined as frequent contiguous n-grams of the action spine, NOT as
// whole-session keys: real sessions never share a byte-identical spine, but they
// DO share sub-runs like `Edit > Bash:git add > Bash:npx vitest > Bash:git commit`
// (validated against 230 real transcripts — §3c).
const MIN_GRAM = 3, MAX_GRAM = 6, MIN_SUPPORT = 2;

// Action spine: drop consecutive-duplicate verbs and pure navigation/inspection
// steps (Read/Grep/Glob and Bash cd/ls/cat/echo/find/grep/…), keeping the action
// verbs (Bash:git/npm/…, Edit, Write).
const NAV_TOOL_RE = /^(Read|Grep|Glob)$/;
const BASH_NAV_RE = /^Bash:(cd|ls|cat|pwd|echo|find|which|head|tail|export|source|sleep|clear|env|true|grep|rg)$/;
// Action spine WITH source indices: drop consecutive-duplicate verbs and pure
// navigation/inspection steps, keeping each surviving verb's first msgIndex.
export function spineWithIndices(steps: ProcedureStep[]): { verb: string; msgIndex: number }[] {
  const spine: { verb: string; msgIndex: number }[] = [];
  for (const { verb, msgIndex } of steps) {
    const base = verb.split(" ")[0];
    if (NAV_TOOL_RE.test(verb) || BASH_NAV_RE.test(base)) continue;
    if (spine[spine.length - 1]?.verb === verb) continue;
    spine.push({ verb, msgIndex });
  }
  return spine;
}
function actionSpine(steps: ProcedureStep[]): string[] {
  return spineWithIndices(steps).map((e) => e.verb);
}

// Is `needle` a contiguous subsequence of `hay`?
function containsRun(hay: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

// Mine maximal frequent n-grams of the action spine. Each kept group = a sub-run
// seen in >= MIN_SUPPORT distinct sessions; a shorter run contained in a kept
// longer run of >= support is dropped as redundant (keep the maximal procedure).
function mineProcedures(sessions: SessionSequence[]): ProcedureGroup[] {
  const spines = sessions.map((s) => actionSpine(s.steps));
  const grams = new Map<string, { verbs: string[]; sess: Set<number> }>();
  spines.forEach((sp, idx) => {
    const seen = new Set<string>();
    for (let n = MIN_GRAM; n <= MAX_GRAM; n++) {
      for (let i = 0; i + n <= sp.length; i++) {
        const verbs = sp.slice(i, i + n);
        const key = verbs.join(" > ");
        if (seen.has(key)) continue;        // count each session once per distinct gram
        seen.add(key);
        let e = grams.get(key);
        if (!e) { e = { verbs, sess: new Set() }; grams.set(key, e); }
        e.sess.add(idx);
      }
    }
  });
  const frequent = [...grams.entries()]
    .map(([key, v]) => ({ key, verbs: v.verbs, sessions: v.sess.size, sampleSessionIdx: [...v.sess][0], sessionIdxs: [...v.sess] }))
    .filter((g) => g.sessions >= MIN_SUPPORT)
    .sort((a, b) => b.verbs.length - a.verbs.length || b.sessions - a.sessions);
  const kept: ProcedureGroup[] = [];
  for (const g of frequent) {
    if (kept.some((k) => k.sessions >= g.sessions && containsRun(k.verbs, g.verbs))) continue;
    kept.push(g);
  }
  return kept.sort((a, b) => b.sessions - a.sessions || b.verbs.length - a.verbs.length).slice(0, PROCEDURES_CAP);
}

// Plain text from a message's content (string, or the text blocks of an array).
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text as string)
      .join("\n");
  }
  return "";
}

// A user message is a genuine human task only if it is not an injected wrapper:
// local-command caveats/echoes, slash-command tags, or a bare system-reminder (§3b).
const WRAPPER_RE = /^\s*<(local-command-caveat|local-command-stdout|command-name|command-message|command-args|system-reminder)\b|^\s*Caveat:/;
function isGenuineUserText(t: string): boolean {
  return t.trim().length > 0 && !WRAPPER_RE.test(t);
}

export function scanWorkflow(paths: string[], inv: ScanInventory, opts: ScanOptions = {}): WorkflowSignal {
  const project = inv.project;
  const scrub = opts.scrub ?? scrubStep;
  const seqSessions: SessionSequence[] = [];
  const global: GlobalArtifacts = inv.global ?? { skills: [], mcpServers: [], hooks: [] };
  // key = `${ns} ${name}` where ns is "p" (project) or "g" (global).
  const used = new Map<string, { type: ArtifactType; acc: Acc }>();
  const unresolved = new Map<string, { kind: ArtifactType | "builtin"; count: number }>();
  const perSession: { ms: number; names: Set<string> }[] = [];
  const notes: string[] = [];
  let firstMs = Infinity, lastMs = 0;

  const touch = (ns: "p" | "g", name: string, type: ArtifactType, ms: number, sessionId: string, evidence?: string) => {
    const key = `${ns} ${name}`;
    let e = used.get(key);
    if (!e) { e = { type, acc: { invocations: 0, sessions: new Set(), lastMs: 0, evidence } }; used.set(key, e); }
    e.acc.invocations++;
    e.acc.sessions.add(sessionId);
    e.acc.lastMs = Math.max(e.acc.lastMs, ms);
  };
  const matchSkill = (list: { name: string }[], skill: string) => list.find((s) => s.name === skill || skill.endsWith(`:${s.name}`));

  for (const path of paths) {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    const ms = safeMtime(path);
    firstMs = Math.min(firstMs, ms); lastMs = Math.max(lastMs, ms);
    const sessionNames = new Set<string>();
    const steps: ProcedureStep[] = [];     // ordered scrubbed builtin calls (retainSequences)
    let firstUserText: string | null = null;
    let lastAssistantText = "";
    const basename = path.split("/").pop() ?? path;
    let sessionId = "";   // first record's sessionId, else synthesized below
    let bad = 0;
    const lines = text.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { bad++; continue; }
      if (!sessionId && typeof rec?.sessionId === "string") sessionId = rec.sessionId;

      // Only ASSISTANT messages carry real tool_use invocations. The system-prompt
      // tool catalog also lists mcp__ names but is NOT an assistant message, so it
      // never reaches this branch — that is the availability-vs-usage guard.
      const role = rec?.message?.role ?? rec?.role;
      const content = rec?.message?.content;

      // Mission hint (§3b): first genuine human turn = the task. Skip sub-agent
      // dispatch (isSidechain), continuation summaries (isCompactSummary), and
      // local-command/system-reminder wrappers.
      if (opts.retainSequences && role === "user" && firstUserText === null && !rec?.isSidechain && !rec?.isCompactSummary) {
        const t = messageText(content);
        if (isGenuineUserText(t)) firstUserText = t;
      }

      if (role === "assistant" && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") { lastAssistantText = block.text; continue; }
          if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
          const name: string = block.name;
          if (name === "Skill" && typeof block.input?.skill === "string") {
            const skill = block.input.skill as string;
            const p = matchSkill(project.skills, skill);
            const g = p ? undefined : matchSkill(global.skills, skill);
            if (p) { touch("p", p.name, "skill", ms, path, `Skill(${skill})`); sessionNames.add(p.name); }
            else if (g) { touch("g", g.name, "skill", ms, path, `Skill(${skill})`); sessionNames.add(g.name); }
            else bumpUnresolved(unresolved, skill, "builtin");
          } else if (name.startsWith("mcp__")) {
            const token = mcpServerToken(name);
            const p = matchMcpServer(token, project.mcpServers);
            const g = p ? null : matchMcpServer(token, global.mcpServers);
            if (p) { touch("p", p, "mcp_server", ms, path, name); sessionNames.add(p); }
            else if (g) { touch("g", g, "mcp_server", ms, path, name); sessionNames.add(g); }
            else bumpUnresolved(unresolved, token, "mcp_server");
          } else {
            bumpUnresolved(unresolved, name, "builtin");
            // Capture the ordered scrubbed builtin step for distillation (§3a/§3c).
            if (opts.retainSequences && !rec?.isSidechain && steps.length < SEQ_CAP_PER_SESSION) {
              try { steps.push({ tool: name, msgIndex: lineIdx, ...scrub(name, block.input) }); }
              catch { notes.push(`scrub failed for a ${name} step in ${path.split("/").pop()}`); }
            }
          }
        }
      }

      // Hook firing is low-confidence: hooks aren't tool_use, they surface as
      // injected "... hook success:" / hook-event text. Match by event + command basename.
      const flat = typeof rec === "string" ? rec : JSON.stringify(rec);
      if (flat.includes("hook success") || /Hook\b/.test(flat)) {
        const matchHooks = (list: HookArtifact[], ns: "p" | "g") => {
          for (const h of list) {
            const cmd = firstHookCommand(h.config);
            const base = cmd ? cmd.split("/").pop()! : "";
            if ((h.event && flat.includes(h.event)) || (base && flat.includes(base))) {
              touch(ns, h.name, "hook", ms, path); sessionNames.add(h.name);
            }
          }
        };
        matchHooks(project.hooks, "p");
        matchHooks(global.hooks, "g");
      }
    }
    if (bad) notes.push(`${bad} unparseable line(s) skipped in ${path.split("/").pop()}`);
    perSession.push({ ms, names: sessionNames });
    if (opts.retainSequences && steps.length > 0) {
      const missionHint: MissionHint | undefined =
        firstUserText !== null ? { task: scrubProse(firstUserText), outcome: scrubProse(lastAssistantText) } : undefined;
      const coords = { sessionId: sessionId || basename.replace(/\.jsonl$/, ""), transcript: basename, atMs: ms };
      seqSessions.push(missionHint ? { steps, missionHint, ...coords } : { steps, ...coords });
    }
  }

  // Builtin-aware procedure recurrence (§3c) — independent of resolved inventory,
  // so builtin-only sessions form procedures and reach Phase-0 (resolves F1).
  let sequences: WorkflowSignal["sequences"];
  let procedures: WorkflowSignal["procedures"];
  if (opts.retainSequences) {
    sequences = { root: project.root, sessions: seqSessions };
    procedures = mineProcedures(seqSessions);
  }

  // Assemble artifacts. Every PROJECT item appears (0 = installed, unused). For
  // GLOBAL we only surface artifacts that were actually used (the global catalog
  // can be huge — installing-but-unused globals are noise here).
  const artifacts: ArtifactUsage[] = [];
  const add = (ns: "p" | "g", type: ArtifactType, name: string, confidence: "high" | "low") => {
    const e = used.get(`${ns} ${name}`);
    artifacts.push({
      type, name, root: ns === "p" ? project.root : null,
      invocations: e?.acc.invocations ?? 0,
      sessionsUsedIn: e?.acc.sessions.size ?? 0,
      lastUsedMs: e?.acc.lastMs || null,
      confidence,
      evidence: e?.acc.evidence,
    });
  };
  for (const s of project.skills) add("p", "skill", s.name, "high");
  for (const m of project.mcpServers) add("p", "mcp_server", m.name, "high");
  for (const h of project.hooks) add("p", "hook", h.name, "low");
  // Instructions are presence-only: loaded every session, never "invoked".
  for (const ins of project.instructions) {
    artifacts.push({
      type: "instructions", name: ins.name, root: project.root,
      invocations: paths.length, sessionsUsedIn: paths.length,
      lastUsedMs: lastMs || null, confidence: "low",
    });
  }
  // Global artifacts that actually fired (root=null → global namespace).
  for (const [key, e] of used) {
    if (!key.startsWith("g ")) continue;
    add("g", e.type, key.slice(2), e.type === "hook" ? "low" : "high");
  }

  // Distinct session shapes: group sessions by their exact artifact-set, count
  // frequency, keep the most common (bounds prompt size on 100s of sessions).
  const shapeCounts = new Map<string, number>();
  for (const s of perSession) {
    if (s.names.size === 0) continue;
    const key = [...s.names].sort().join(" ");
    shapeCounts.set(key, (shapeCounts.get(key) ?? 0) + 1);
  }
  const shapes = [...shapeCounts.entries()]
    .map(([k, sessions]) => ({ artifacts: k.split(" "), sessions }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 25);

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
    root: project.root,
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
    shapes,
    sequences,
    procedures,
    notes: paths.length === 0 ? [...notes, "no transcripts found for this project"] : notes,
  };
}

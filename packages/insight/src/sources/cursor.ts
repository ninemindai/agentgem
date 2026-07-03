// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Cursor ingestion. Sessions live in a binary SQLite DB (state.vscdb, table cursorDiskKV):
// composerData:<id> rows (session + ordered bubble headers) and bubbleId:<id>:<bid> rows (one
// message each). Cell values are JSON STRINGS (double-decode). The DB is WAL-mode and locked
// while Cursor runs, so we COPY it (+ sidecars) to a temp file and open read-only. Metadata only:
// we read a bubble's type/createdAt/token fields — NEVER its text/thinking/codeBlocks/toolFormerData.
// Total: a missing/locked/corrupt DB or malformed blob degrades to [] / skip, never throws.
// node:sqlite is imported LAZILY inside scanCursorSessions (not at module top level) so this module —
// and the whole app, which the desktop Electron main process dynamically imports — stays loadable on
// a runtime that lacks node:sqlite (Electron <= 33 bundles Node 20; node:sqlite needs Node >= 24). There
// the lazy import() rejects and the scan degrades to [] via the surrounding catch, instead of throwing
// ERR_UNKNOWN_BUILTIN_MODULE at load time and breaking the embedded server's boot. The import is
// resolved FIRST, before the DB is copied, so a Node < 24 host never pays for a pointless copy of
// the (possibly multi-file WAL) DB on every scan. The loader is an injectable param (defaults to the
// real `import("node:sqlite")`) so the unavailable-module path is directly testable.
import { copyFile, mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { classifyMcpServer, stripYamlFrontmatter } from "@agentgem/model";
import type { GemArtifact } from "@agentgem/model";
import type { SessionStat } from "../observeAggregate.js";
import type { ImportResult } from "../sources.js";

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const parse = (s: unknown): Record<string, unknown> | null => {
  if (typeof s !== "string") return (s && typeof s === "object") ? s as Record<string, unknown> : null;
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
};

interface KV { key: string; value: string }

// Loose shape of node:sqlite's DatabaseSync actually used here (prepare/get/all/close) — typed
// pragmatically rather than importing the real module's types, so a fake loader can be injected
// in tests without node:sqlite needing to exist.
interface SqliteDb { prepare(sql: string): { get(): unknown; all(): unknown[] }; close(): void }
type LoadSqlite = () => Promise<{ DatabaseSync: new (path: string, opts: { readOnly: boolean }) => SqliteDb }>;
const defaultLoadSqlite: LoadSqlite = () => import("node:sqlite");

/** Pure core: fold cursorDiskKV rows into one SessionStat per composer. Exported for testing. */
export function aggregateComposers(rows: KV[]): SessionStat[] {
  // group bubbles by composerId (from the key bubbleId:<composerId>:<bubbleId>)
  const composers = new Map<string, Record<string, unknown>>();
  const bubblesByComposer = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    if (r.key.startsWith("composerData:")) {
      const id = r.key.slice("composerData:".length);
      const o = parse(r.value); if (o) composers.set(id, o);
    } else if (r.key.startsWith("bubbleId:")) {
      const rest = r.key.slice("bubbleId:".length);
      const composerId = rest.split(":")[0];
      const o = parse(r.value); if (!o) continue;
      (bubblesByComposer.get(composerId) ?? bubblesByComposer.set(composerId, []).get(composerId)!).push(o);
    }
  }
  const out: SessionStat[] = [];
  for (const [id, composer] of composers) {
    const bubbles = bubblesByComposer.get(id) ?? [];
    const headers = composer.fullConversationHeadersOnly;
    const msgs = Array.isArray(headers) ? headers.length : bubbles.length;
    if (msgs === 0) continue;
    let startMs = Infinity, endMs = -Infinity, tIn = 0, tOut = 0; let model: string | null = null;
    for (const b of bubbles) {
      const ts = n(b.createdAt);
      if (ts > 0) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); }
      tIn += n(b.inputTokens); tOut += n(b.outputTokens);
      if (!model && typeof b.model === "string") model = b.model;   // best-effort
    }
    if (typeof composer.lastUsedModel === "string" && !model) model = composer.lastUsedModel as string;
    if (endMs < startMs) { startMs = 0; endMs = 0; }
    out.push({ agent: "cursor", sessionId: id, project: null, model, gitBranch: null, startMs, endMs, msgs, tokensIn: tIn, tokensOut: tOut, tokensCache: 0 });
  }
  return out;
}

export async function scanCursorSessions(dbPath: string, loadSqlite: LoadSqlite = defaultLoadSqlite): Promise<SessionStat[]> {
  // Resolve node:sqlite BEFORE any copy work: on Node < 24 the import rejects immediately, so
  // there's no point copying the (possibly multi-file WAL) DB just to fail afterward.
  let DatabaseSync: new (path: string, opts: { readOnly: boolean }) => SqliteDb;
  try { ({ DatabaseSync } = await loadSqlite()); } catch { return []; }

  // copy-before-read: never open Cursor's live (WAL-locked) DB in place.
  let tmp: string | null = null;
  try {
    tmp = await mkdtemp(join(tmpdir(), "cursor-db-"));
    const copyPath = join(tmp, "state.vscdb");
    await copyFile(dbPath, copyPath);                         // throws if dbPath absent -> caught below
    for (const ext of ["-wal", "-shm"]) { try { await copyFile(dbPath + ext, copyPath + ext); } catch { /* sidecar may not exist */ } }
    let rows: KV[] = [];
    try {
      const db = new DatabaseSync(copyPath, { readOnly: true });
      try {
        // cursorDiskKV may not exist on very old/legacy DBs -> guard.
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'").get();
        if (has) rows = db.prepare("SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%' ORDER BY rowid").all() as unknown as KV[];
      } finally { db.close(); }
    } catch { return []; }
    return aggregateComposers(rows);
  } catch { return []; }
  finally { if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* best effort */ } } }
}

// Artifact (authoring) face: .cursor/rules/*.mdc + .cursorrules (legacy) + AGENTS.md -> instructions,
// .cursor/mcp.json -> mcp_server / package reference. Cursor's mcp.json is an object-map keyed by
// server name (like Cline), not Continue's array shape. classifyMcpServer (shared with
// cline/gemini/continue, see packages/model/src/publicPackage.ts) references public npx packages
// and redacts everything else — secret-bearing `env` is never ingested.

// Cursor's description/globs/alwaysApply frontmatter is rule-activation metadata not represented
// in the neutral Gem; only the markdown body becomes the instructions artifact's content. Reuses
// @agentgem/model's stripYamlFrontmatter (CRLF-safe) rather than a locally re-derived regex.

export async function readCursorArtifacts(env: { rulesDir?: string; cursorrules?: string; agentsMd?: string; mcpFile?: string }): Promise<ImportResult> {
  const artifacts: GemArtifact[] = [];
  if (env.rulesDir) {
    let files: string[]; try { files = (await readdir(env.rulesDir)).filter((f) => f.toLowerCase().endsWith(".mdc")); } catch { files = []; }
    for (const f of files) {
      try { const body = stripYamlFrontmatter(await readFile(join(env.rulesDir, f), "utf8")); if (body.trim()) artifacts.push({ type: "instructions", name: basename(f).replace(/\.mdc$/i, ""), content: body }); } catch { /* skip */ }
    }
  }
  for (const [path, name] of [[env.cursorrules, "cursorrules"], [env.agentsMd, "agents"]] as const) {
    if (!path) continue;
    try { const c = await readFile(path, "utf8"); if (c.trim()) artifacts.push({ type: "instructions", name, content: c }); } catch { /* absent */ }
  }
  if (env.mcpFile) {
    try {
      const raw = JSON.parse(await readFile(env.mcpFile, "utf8")) as { mcpServers?: Record<string, { command?: string; args?: unknown; url?: string }> };
      for (const [name, cfg] of Object.entries(raw.mcpServers ?? {})) artifacts.push(classifyMcpServer(name, cfg));  // object-map, like cline
    } catch { /* absent/malformed */ }
  }
  return { artifacts, binding: { agent: "cursor", origin: "imported" } };
}

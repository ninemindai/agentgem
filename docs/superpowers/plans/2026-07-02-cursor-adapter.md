# Cursor Adapter Implementation Plan (Phase 3, final adapter)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a symmetric Cursor adapter (SQLite session scan + plain-file artifact import + materialize target) on the multi-agent-sources abstraction, proven with a round-trip — validating that the abstraction absorbs a binary SQLite session backend with no core changes.

**Architecture:** A `cursor` `SourceSpec` whose `scanSessions` reads Cursor's `state.vscdb` SQLite (`cursorDiskKV` composerData + bubble blobs) via `better-sqlite3` (copy-before-read, read-only), and whose `readArtifacts` reads plain files (`.cursor/rules/*.mdc`, `.cursorrules`, `AGENTS.md`, `.cursor/mcp.json`); plus a `cursor` `TargetSpec` (per-type renderers → `.cursor/rules/*.mdc` + `.cursor/mcp.json`). Registered on the existing `AGENT_SOURCES`/`TARGET_REGISTRY`. Pure plug-in on the merged abstraction (Cline + Gemini + Continue already on `main`).

**Tech Stack:** TypeScript (ESM, `.js` suffixes), pnpm workspaces, Vitest, `@agentgem/model`/`@agentgem/insight`/`@agentgem/archive`, the built-in `node:sqlite` (NO new dependency — see below).

**Base branch:** `cursor-source`, off fresh `origin/main` (contains the full abstraction + Cline + Gemini + Continue — no stacking).

## SQLite reader (no dependency) + Node floor

Cursor stores sessions in SQLite (`state.vscdb`); there is no reliable non-SQLite path (the plain JSONL transcripts lack token/model). We use Node's **built-in `node:sqlite`** (`DatabaseSync`) — **no new dependency, no native-addon build**. `node:sqlite` runs flag-free on **Node ≥ 24** (it needs `--experimental-sqlite` on Node 22), so this plan **raises the Node floor to 24** (Task 0): the CI matrix drops 22 → `[24, 26]`, and `package.json` `engines.node` becomes `>=24`. It still emits an `ExperimentalWarning` on stderr (harmless; does not fail tests).

**Branch-protection consequence (repo-wide, handle explicitly):** `main`'s required status checks currently include `test (22)`. Dropping 22 from the matrix means that check never runs and PRs block. The required contexts must be updated to `[test (24), test (26)]` — a repo-settings change (admin) confirmed with the human before/at merge time, NOT silently.

## Verified Cursor formats (from docs + community reverse-engineering; SQLite internals are MED confidence)

- **`.cursor/rules/*.mdc`** — Markdown body + YAML frontmatter (`description`, `globs`, `alwaysApply`). `.md` (no frontmatter) is ignored by Cursor; `.mdc` required. HIGH.
- **`.cursorrules`** (legacy, deprecated) — plain text at repo root. Read on import; do NOT emit on export. MED.
- **`AGENTS.md`** — plain Markdown, repo root. HIGH.
- **`.cursor/mcp.json`** (+ `~/.cursor/mcp.json`) — Claude-desktop **object-map** `mcpServers` (keyed by name); stdio `command`/`args`/`env`, remote `url`/`headers`. HIGH. (Same shape as Cline → `classifyMcpServer` reuses directly.)
- **Sessions — `state.vscdb` SQLite** (`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`): table `cursorDiskKV` (TEXT key, BLOB value = a JSON **string**, double-decode). Keys: `composerData:<composerId>` (session; `_v:3` has `fullConversationHeadersOnly: [{bubbleId, type}]`) and `bubbleId:<composerId>:<bubbleId>` (one message: `type` 1=user/2=assistant, `createdAt`, `tokenCount`/`inputTokens`/`outputTokens`, `text`, `toolFormerData`, …). WAL-mode, locked while Cursor runs → **copy-before-read, open read-only**. Model is not a clean field here (best-effort → null). Token fields present on many but not all bubbles (best-effort). MED.

### SessionStat mapping (Cursor → neutral SessionStat)
- `agent: "cursor"`; `sessionId` = the `composerId`; `project: null` (composerData carries no clean cwd); `model` = best-effort (a bubble/composer `model`/`lastUsedModel` field if present, else `null`); `gitBranch: null`.
- Over the session's bubbles: `startMs`/`endMs` = min/max of bubble `createdAt` (ms epoch numbers); if none parseable, fall back to `0`/`0` → session dropped (see totality).
- `msgs` = `fullConversationHeadersOnly.length` if present, else the count of bubble rows for the composer.
- `tokensIn = Σ inputTokens`, `tokensOut = Σ outputTokens`, `tokensCache = 0` (Cursor exposes no clean cache-token field). All via a finite-number guard (`n()`), so a missing/garbage field contributes 0, never NaN.
- **Privacy:** NEVER read bubble `text`/`thinking`/`codeBlocks`/`toolFormerData`. Only `type`, `createdAt`, and the token integer fields.

## Global Constraints

- **Privacy — metadata only.** Session scanning reads timing/token/type/id ONLY — never message text or any content blob.
- **Secrets never ingested.** MCP `env`/`headers` redacted via `classifyMcpServer` (allowlist copy).
- **Total functions.** Missing DB / locked DB / malformed blob / malformed JSON / absent files degrade to empty/skip, never throw. Absent Cursor install ⇒ the source contributes nothing.
- **Copy-before-read.** Never open Cursor's live DB in place; copy `state.vscdb` (+ `-wal`/`-shm` sidecars if present) to a temp path, open read-only, delete the copy after.
- **Digest boundary.** References lock-pinned (signed); `bindings` unsigned in-memory overlay.
- **TEST LOCATION.** Root Vitest only globs `dist/**/__tests__/**/*.test.js` compiled from the **root `src/` tree**. Every new test MUST live at `src/gem/__tests__/<name>.test.ts` and import from the published packages. Confirm each new test is collected by root `pnpm test`.
- **Test command.** Root `pnpm test`; tests run from compiled `dist/` — build before testing. NEVER pipe `pnpm test` through `tail`; redirect to a file, read the summary + `$?`.
- **Known flaky suites.** aggregator (`catalogShare`/`detection`/`sweepController`) + transfer (`seal`) + occasionally `authInstall` crypto tests TIME OUT under load — not regressions. If only those fail, re-run in isolation to confirm, then treat green.
- **Commits.** Author `Raymond Feng <raymond@ninemind.ai>`; trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly + verify `git show HEAD`.
- **Reuse `classifyMcpServer`** from `@agentgem/model` for MCP import (do NOT re-implement the classify+redact branch).

---

## File Structure

- `packages/insight/src/sources/cursor.ts` — **create**: `parseCursorDb`/`scanCursorSessions` (SQLite), `readCursorArtifacts`.
- `packages/insight/src/index.ts` — **modify**: export the cursor functions.
- `packages/insight/package.json` — **modify**: add `better-sqlite3` dep (+ `@types/better-sqlite3` dev).
- `packages/insight/src/sources.ts` — **modify**: add `cursorSource` to `BUILTIN_SOURCES`.
- `packages/model/src/targets.ts` — **modify**: add `cursor` to `TargetId` + `TARGET_REGISTRY` (per-type renderers).
- Tests: `src/gem/__tests__/{cursor.scan,cursor.artifacts,cursor.source,targets.cursor,cursor.roundtrip}.test.ts`, plus id-list updates in `sources.test.ts`, `sourceRegistry.test.ts`, `targets.test.ts`, `schemas.test.ts`.

---

## Task 0: Raise the Node floor to 24 (enables node:sqlite)

**Files:**
- Modify: `.github/workflows/ci.yml` (matrix `[22, 24, 26]` → `[24, 26]`)
- Modify: root `package.json` (`engines.node` → `>=24`); any per-package `engines` if present.

**Interfaces:** none (infra).

- [ ] **Step 1: Read the CI workflow** — `.github/workflows/ci.yml`. Find the matrix (likely `node-version: [22, 24, 26]` or `strategy.matrix.node`). Confirm the job name that produces the `test (NN)` checks.

- [ ] **Step 2: Drop Node 22** — change the matrix to `[24, 26]`. Update root `package.json` `engines` to `{ "node": ">=24" }` (add if absent). Grep for other `"node":` engines fields in `packages/*/package.json` and bump any that pin `>=22`.

- [ ] **Step 3: Verify locally** — `node --version` (should be ≥24 on this machine). Build + a quick `pnpm test cursor` will come in later tasks; here just confirm the YAML/JSON parse (no syntax error): `node -e "require('js-yaml')" 2>/dev/null || true` is not needed — just re-read the edited ci.yml to confirm valid YAML by eye.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml package.json
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "ci: raise Node floor to 24 (drop 22) to enable built-in node:sqlite

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> The `test (22)` required status check on `main` must be removed from branch protection (repo-settings, admin) or PRs block — the controller handles this with the human at push/merge time, not in this task.

---

## Task 1: Cursor SQLite session scan → SessionStat (the hard one)

**Files:**
- Create: `packages/insight/src/sources/cursor.ts`
- Modify: `packages/insight/src/index.ts` (export)
- Test: `src/gem/__tests__/cursor.scan.test.ts`

**Interfaces:**
- Produces: `scanCursorSessions(dbPath: string): Promise<SessionStat[]>` (copies the DB, reads `cursorDiskKV`, returns one SessionStat per composer). Internal `aggregateComposers(rows: {key:string; value:string}[]): SessionStat[]` (pure — the testable core over already-read rows).

- [ ] **Step 1: No dependency — verify node:sqlite types** — we use the built-in `node:sqlite`. Confirm `@types/node` in the repo is recent enough to type `node:sqlite` (v22.5+ typings). Quick check: in `packages/insight`, `import { DatabaseSync } from "node:sqlite";` should typecheck after build. If `@types/node` lacks it, either bump `@types/node` (devDep) or add a one-line ambient `declare module "node:sqlite"` shim — prefer bumping `@types/node`. No runtime dependency is added.

- [ ] **Step 2: Write the failing test** — builds a REAL `state.vscdb` with `node:sqlite`, then scans it.

```ts
// src/gem/__tests__/cursor.scan.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scanCursorSessions } from "@agentgem/insight";

function makeDb(dir: string): string {
  const path = join(dir, "state.vscdb");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  // one composer with 2 bubbles (1 user, 1 assistant). value is a JSON STRING (double-encode).
  put.run("composerData:c1", JSON.stringify({ composerId: "c1", _v: 3, fullConversationHeadersOnly: [ { bubbleId: "b1", type: 1 }, { bubbleId: "b2", type: 2 } ] }));
  put.run("bubbleId:c1:b1", JSON.stringify({ type: 1, createdAt: 1751328000000, text: "SECRET user text" }));
  put.run("bubbleId:c1:b2", JSON.stringify({ type: 2, createdAt: 1751328600000, text: "SECRET reply", inputTokens: 100, outputTokens: 40, tokenCount: 140, model: "claude-sonnet-5" }));
  db.close();
  return path;
}

describe("Cursor SQLite scan", () => {
  it("aggregates a composer + bubbles into a SessionStat; never reads bubble text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-"));
    const dbPath = makeDb(dir);
    const stats = await scanCursorSessions(dbPath);
    expect(stats).toHaveLength(1);
    const s = stats[0];
    expect(s).toMatchObject({ agent: "cursor", sessionId: "c1", msgs: 2 });
    expect(s.tokensIn).toBe(100);
    expect(s.tokensOut).toBe(40);
    expect(s.startMs).toBe(1751328000000);
    expect(s.endMs).toBe(1751328600000);
    expect(JSON.stringify(s)).not.toContain("SECRET"); // privacy: no bubble text in the stat
  });
  it("returns [] for a missing DB, never throws", async () => {
    await expect(scanCursorSessions("/no/such/state.vscdb")).resolves.toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm test cursor.scan`
Expected: FAIL — `scanCursorSessions` not exported.

- [ ] **Step 4: Implement `cursor.ts`**

```ts
// packages/insight/src/sources/cursor.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Cursor ingestion. Sessions live in a binary SQLite DB (state.vscdb, table cursorDiskKV):
// composerData:<id> rows (session + ordered bubble headers) and bubbleId:<id>:<bid> rows (one
// message each). Cell values are JSON STRINGS (double-decode). The DB is WAL-mode and locked
// while Cursor runs, so we COPY it (+ sidecars) to a temp file and open read-only. Metadata only:
// we read a bubble's type/createdAt/token fields — NEVER its text/thinking/codeBlocks/toolFormerData.
// Total: a missing/locked/corrupt DB or malformed blob degrades to [] / skip, never throws.
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionStat } from "../observeAggregate.js";

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const parse = (s: unknown): Record<string, unknown> | null => {
  if (typeof s !== "string") return (s && typeof s === "object") ? s as Record<string, unknown> : null;
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
};

interface KV { key: string; value: string }

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

export async function scanCursorSessions(dbPath: string): Promise<SessionStat[]> {
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
        if (has) rows = db.prepare("SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%'").all() as unknown as KV[];
      } finally { db.close(); }
    } catch { return []; }
    return aggregateComposers(rows);
  } catch { return []; }
  finally { if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* best effort */ } } }
}
```
Export from `packages/insight/src/index.ts`: `export * from "./sources/cursor.js";`

> Note on double-decode: the `value` BLOB is stored as a JSON string; `CAST(value AS TEXT)` + `JSON.parse` yields the object. We never touch nested stringified fields (toolFormerData.params etc.) — metadata only.

- [ ] **Step 5: Build + run**

Run: `pnpm build && pnpm test cursor.scan`
Expected: PASS — `dist/gem/__tests__/cursor.scan.test.js` collected + green (the real-SQLite fixture is written and scanned).

- [ ] **Step 6: Commit**

```bash
git add packages/insight/src/sources/cursor.ts packages/insight/src/index.ts src/gem/__tests__/cursor.scan.test.ts
# (+ packages/insight/package.json if @types/node was bumped for node:sqlite typings)
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): Cursor SQLite session scan via node:sqlite (cursorDiskKV, copy-before-read)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Cursor artifact import (.cursor/rules + .cursorrules + AGENTS.md + .cursor/mcp.json)

**Files:**
- Modify: `packages/insight/src/sources/cursor.ts` (append `readCursorArtifacts`)
- Test: `src/gem/__tests__/cursor.artifacts.test.ts`

**Interfaces:**
- Consumes: `ImportResult` (`sources.ts`), `classifyMcpServer` (`@agentgem/model`), `GemArtifact` (`@agentgem/model`).
- Produces: `readCursorArtifacts(env: { rulesDir?: string; cursorrules?: string; agentsMd?: string; mcpFile?: string }): Promise<ImportResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/cursor.artifacts.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursorArtifacts } from "@agentgem/insight";

describe("Cursor artifact import", () => {
  it("imports .mdc rules (frontmatter stripped) + mcp.json object-map (ref/redacted)", async () => {
    const base = mkdtempSync(join(tmpdir(), "cursor-a-"));
    const rulesDir = join(base, ".cursor", "rules"); mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "style.mdc"), "---\ndescription: style\nglobs: \"*.ts\"\nalwaysApply: true\n---\nPrefer small diffs.");
    writeFileSync(join(base, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
      local: { command: "node", args: ["./s.js"], env: { TOKEN: "secret" } },
    } }));
    const { artifacts, binding } = await readCursorArtifacts({ rulesDir, mcpFile: join(base, ".cursor", "mcp.json") });
    const instr = artifacts.find((a) => a.type === "instructions");
    expect(instr).toMatchObject({ name: "style", content: "Prefer small diffs." }); // frontmatter stripped
    expect(artifacts.find((a) => a.type === "reference")).toMatchObject({ ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } });
    const local = artifacts.find((a) => a.type === "mcp_server");
    expect(JSON.stringify(local)).not.toContain("secret");
    expect(binding).toMatchObject({ agent: "cursor", origin: "imported" });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @agentgem/insight build && pnpm test cursor.artifacts` → FAIL (not exported).

- [ ] **Step 3: Implement `readCursorArtifacts`** — append to `cursor.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { basename } from "node:path";
import { classifyMcpServer } from "@agentgem/model";
import type { GemArtifact } from "@agentgem/model";
import type { ImportResult } from "../sources.js";

// Strip a leading YAML frontmatter block (--- ... ---) from an .mdc rule, returning the body.
function stripFrontmatter(text: string): string {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? text.slice(m[0].length).trimStart() : text;
}

export async function readCursorArtifacts(env: { rulesDir?: string; cursorrules?: string; agentsMd?: string; mcpFile?: string }): Promise<ImportResult> {
  const artifacts: GemArtifact[] = [];
  if (env.rulesDir) {
    let files: string[]; try { files = (await readdir(env.rulesDir)).filter((f) => f.toLowerCase().endsWith(".mdc")); } catch { files = []; }
    for (const f of files) {
      try { const body = stripFrontmatter(await readFile(join(env.rulesDir, f), "utf8")); if (body.trim()) artifacts.push({ type: "instructions", name: basename(f, ".mdc"), content: body }); } catch { /* skip */ }
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
```

- [ ] **Step 4: Build + run** — `pnpm build && pnpm test cursor.artifacts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sources/cursor.ts src/gem/__tests__/cursor.artifacts.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): Cursor artifact import (.mdc rules + mcp.json via classifyMcpServer)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Register the `cursor` SourceSpec

**Files:**
- Modify: `packages/insight/src/sources.ts`
- Test: `src/gem/__tests__/cursor.source.test.ts` + update id-list in `sources.test.ts` and counts in `sourceRegistry.test.ts` (5→6 built-ins).

**Interfaces:**
- Produces: `cursorSource: SourceSpec` (`id:"cursor"`, `label:"Cursor"`, `traits.storage:"sqlite"`), `roots(env)` → the global `state.vscdb` path, `scanSessions` → `scanCursorSessions(root)`, `readArtifacts: async () => readCursorArtifacts({})` (stub, per-repo paths later).

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/cursor.source.test.ts
import { describe, it, expect } from "vitest";
import { BUILTIN_SOURCES } from "@agentgem/insight";

describe("cursor SourceSpec", () => {
  it("is registered with sqlite storage and both faces", () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "cursor");
    expect(c?.traits.storage).toBe("sqlite");
    expect(typeof c?.scanSessions).toBe("function");
    expect(typeof c?.readArtifacts).toBe("function");
  });
  it("absent Cursor DB yields [] sessions, never throws", async () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "cursor")!;
    await expect(c.scanSessions!(c.roots({ baseDir: "/no/such" }))).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @agentgem/insight build && pnpm test cursor.source` → FAIL.

- [ ] **Step 3: Add `cursorSource`** — in `packages/insight/src/sources.ts`:

```ts
import { scanCursorSessions, readCursorArtifacts } from "./sources/cursor.js";

// Cursor's global session DB. macOS default; baseDir overrides for tests (points at a dir holding state.vscdb).
function cursorDbPath(baseDir?: string): string {
  return baseDir
    ? join(baseDir, "state.vscdb")
    : join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
}

const cursorSource: SourceSpec = {
  id: "cursor", label: "Cursor", traits: { storage: "sqlite" },
  roots: (env) => [cursorDbPath(env.baseDir)],
  scanSessions: async (roots) => (await Promise.all(roots.map((r) => scanCursorSessions(r)))).flat(),
  readArtifacts: async () => readCursorArtifacts({}),   // per-repo rule/mcp paths supplied by callers later
};
```
Add `cursorSource` to `BUILTIN_SOURCES` (order: `[claude, codex, cline, gemini, continue, cursor]`).

- [ ] **Step 4: Update the hardcoded id-list assertions** (6th source):
- `sources.test.ts`: sorted list → `["claude", "cline", "codex", "continue", "cursor", "gemini"]`.
- `sourceRegistry.test.ts`: registration-order id-list → `[..., "continue", "cursor"]`; `r.all()` length `5→6`; `defaultSourceRegistry.all().length` `5→6`; wired-container `all().length` `6→7`. Read current values, update exactly, no weakening.

- [ ] **Step 5: Build + run** — `pnpm build && pnpm test cursor.source sources sourceRegistry` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/insight/src/sources.ts src/gem/__tests__/cursor.source.test.ts src/gem/__tests__/sources.test.ts src/gem/__tests__/sourceRegistry.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): register cursor SourceSpec

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Cursor `TargetSpec` (.cursor/rules/*.mdc + .cursor/mcp.json)

Cursor uses separate files per rule (per-type renderers, like cline/gemini — NOT compose).

**Files:**
- Modify: `packages/model/src/targets.ts` (add `"cursor"` to `TargetId` + `TARGET_REGISTRY`)
- Test: `src/gem/__tests__/targets.cursor.test.ts` + add `"cursor"` to hardcoded lists in `src/__tests__/schemas.test.ts` and `src/gem/__tests__/targets.test.ts`.

**Interfaces:**
- Produces: `TARGET_REGISTRY.cursor` — `instructions`/`skill` → `.cursor/rules/<name>.mdc`, `mcp` → `.cursor/mcp.json`.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/targets.cursor.test.ts
import { describe, it, expect } from "vitest";
import { materialize } from "@agentgem/model";
import type { Gem } from "@agentgem/model";

const gem: Gem = { name: "g", createdFrom: "t", checks: [], requiredSecrets: [], artifacts: [
  { type: "instructions", name: "style", content: "Prefer small diffs." },
  { type: "mcp_server", name: "local", transport: "stdio", config: { command: "node", args: ["s.js"] } },
  { type: "reference", name: "context7", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } },
] };

describe("cursor target", () => {
  it("writes .cursor/rules/*.mdc (with frontmatter) and .cursor/mcp.json (ref as npx)", () => {
    const { files } = materialize(gem, "cursor");
    const mdc = files[".cursor/rules/style.mdc"];
    expect(mdc).toContain("alwaysApply: true");
    expect(mdc).toContain("Prefer small diffs.");
    const mcp = JSON.parse(files[".cursor/mcp.json"]);
    expect(mcp.mcpServers.local).toMatchObject({ command: "node", args: ["s.js"] });
    expect(mcp.mcpServers.context7).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @agentgem/model build && pnpm test targets.cursor` → FAIL (`"cursor"` not a TargetId).

- [ ] **Step 3: Implement the target** — in `packages/model/src/targets.ts`:
- Widen `TargetId`: add `| "cursor"`.
- Renderers:
```ts
// Minimal always-on rule frontmatter; the neutral Gem doesn't carry Cursor's description/globs.
const mdcRule = (name: string, body: string): FileTree => ({
  [`.cursor/rules/${safePathSegment(name)}.mdc`]: `---\ndescription: ""\nglobs: ""\nalwaysApply: true\n---\n${body}\n`,
});
const skillCursor = (a: SkillArtifact): FileTree => mdcRule(a.name, a.content);
const instructionsCursor = (all: InstructionsArtifact[]): FileTree => {
  const files: FileTree = {};
  for (const i of all) Object.assign(files, mdcRule(i.name, i.content));
  return files;
};
const mcpCursorJson = (servers: McpServerArtifact[]): MaterializeResult => {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) mcpServers[s.name] = s.config;   // already redacted at import
  return rendered({ ".cursor/mcp.json": JSON.stringify({ mcpServers }, null, 2) });
};
```
- Register:
```ts
  cursor: { id: "cursor", label: "Cursor", skill: skillCursor, instructions: instructionsCursor, mcp: mcpCursorJson },
```
> `instructionsCursor` emits one `.mdc` per instruction (distinct names); `skillCursor` also writes into `.cursor/rules/` — a same-name skill+instruction would collide and be skipped by materialize's `merge` (acceptable edge case, consistent with sibling targets). The package reference reaches `mcp` via materialize's ref-batching, rendering `context7` as an npx entry — verify in Step 4.

- [ ] **Step 4: Update hardcoded target lists + build + run**
- `src/__tests__/schemas.test.ts` (compatibility record) and `src/gem/__tests__/targets.test.ts` (sorted keys): insert `"cursor"` alphabetically.

Run: `pnpm build && pnpm test targets.cursor targets schemas` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/targets.ts src/gem/__tests__/targets.cursor.test.ts src/__tests__/schemas.test.ts src/gem/__tests__/targets.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(model): cursor materialize target (.cursor/rules/*.mdc + .cursor/mcp.json)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Round-trip integration proof

**Files:**
- Test: `src/gem/__tests__/cursor.roundtrip.test.ts`

**Interfaces:**
- Consumes: `readCursorArtifacts` (Task 2), `materialize` (Task 4), `writeGemArchive`/`readGemArchive` (`@agentgem/archive`).

- [ ] **Step 1: Write the round-trip test**

```ts
// src/gem/__tests__/cursor.roundtrip.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursorArtifacts } from "@agentgem/insight";
import { materialize } from "@agentgem/model";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

describe("Cursor round-trip: import -> Gem -> archive -> materialize back", () => {
  it("reproduces the rule body + MCP (package ref as npx); binding dropped by the archive", async () => {
    const base = mkdtempSync(join(tmpdir(), "cursor-rt-"));
    const rulesDir = join(base, ".cursor", "rules"); mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "style.mdc"), "---\nalwaysApply: true\n---\nPrefer small diffs.");
    writeFileSync(join(base, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] } } }));

    const { artifacts, binding } = await readCursorArtifacts({ rulesDir, mcpFile: join(base, ".cursor", "mcp.json") });
    const gem: Gem = { name: "imported", createdFrom: "cursor", artifacts, checks: [], requiredSecrets: [], bindings: [binding] };

    const back = readGemArchive(writeGemArchive(gem).files);
    expect(back.artifacts).toEqual(gem.artifacts);   // rule body + ref survive the signed archive
    expect(back.bindings).toBeUndefined();

    const { files } = materialize(back, "cursor");
    expect(files[".cursor/rules/style.mdc"]).toContain("Prefer small diffs.");
    expect(JSON.parse(files[".cursor/mcp.json"]).mcpServers.context7).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
```
> Round-trip fidelity note: import strips the `.mdc` frontmatter (Cursor's description/globs/alwaysApply are rule-activation metadata not represented in the neutral Gem), so the exported `.mdc` carries regenerated minimal frontmatter, not the original. The test asserts the rule BODY survives — that's the neutral-content guarantee.

- [ ] **Step 2: Run it (should pass; if it fails, a real cross-task seam is broken — report, don't weaken).**

Run: `pnpm build && pnpm test cursor.roundtrip` → PASS.

- [ ] **Step 3: Full suite** — `pnpm test > /tmp/cursor-suite.log 2>&1; echo $?`, read the summary. Only the known crypto flakes may fail — verify in isolation. `node:sqlite` emits an `ExperimentalWarning` on stderr — that's expected and does NOT fail tests; if a cursor.scan/roundtrip test errors with "node:sqlite is not available" the runner is on Node < 24 (should not happen after Task 0) — report it.

- [ ] **Step 4: Commit**

```bash
git add src/gem/__tests__/cursor.roundtrip.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "test(insight): Cursor import->gem->archive->materialize round-trip proof

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** SQLite session scan with copy-before-read + double-decode + real-DB fixture test (Task 1); symmetric import of .mdc rules/.cursorrules/AGENTS.md/mcp.json via classifyMcpServer (Task 2); registration + id-list fallout (Task 3); per-type materialize target → native .cursor layout (Task 4); round-trip proof (Task 5). Full symmetric incl. SQLite per the decision.
- **Type consistency:** `SessionStat` shape matches `observeAggregate.ts`; `classifyMcpServer`/`ImportResult`/`AgentBinding` reused; `McpServerArtifact` object-map handled on import (Object.entries) and export ({name: config}). `agent:"cursor"` needs no enum change (AgentId is string; canonicalHarness passes through).
- **Privacy:** the scan reads only bubble type/createdAt/token integers — never text/thinking/codeBlocks/toolFormerData; the test asserts no bubble text leaks into the SessionStat.
- **Risk (flagged):** node:sqlite is built-in (no native-addon build), but requires the Node-floor bump (Task 0) + the branch-protection required-check update (controller/human at merge). SQLite blob shapes are MED confidence (reverse-engineered) — the parser is defensive (guards missing fields, tolerates legacy `_v`, degrades to []/skip). store.db cross-DB model join is deferred (model best-effort → null from state.vscdb).
- **Known deferrals:** `cursorSource.readArtifacts` is the same registry stub as the other adapters; store.db integration + the two-disjoint-replay-stacks reconciliation are follow-ups.

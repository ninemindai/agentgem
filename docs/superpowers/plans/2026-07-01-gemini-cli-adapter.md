# Gemini CLI Adapter Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a symmetric Gemini CLI adapter (source + target) on the multi-agent-sources abstraction, proven with a round-trip — and hoist the duplicated public-npm classifier to a shared util.

**Architecture:** A `gemini` `SourceSpec` (session scan folding the JSONL mutation records; artifact import of GEMINI.md + settings.json mcpServers + commands/*.toml) and a `gemini` `TargetSpec` (materialize back into `~/.gemini`'s native layout), registered on the existing `AGENT_SOURCES`/`TARGET_REGISTRY`. No abstraction changes — a pure plug-in, exactly as Cline was.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), pnpm workspaces, Vitest, `@agentgem/model`/`@agentgem/insight`/`@agentgem/archive`.

**Base branch:** `gemini-source`, stacked on `multi-agent-sources` (PR #58, unmerged) — the abstraction (`SourceSpec`, `AGENT_SOURCES`, `ReferenceArtifact`, the Cline adapter) lives there, NOT on `origin/main`.

## Global Constraints

- **Privacy — metadata only.** Session scanning reads timing/token/model/type/id ONLY, never message `content` text.
- **Secrets never ingested.** MCP `env`/`headers` redacted on import; a binding's `secretMap` holds env-var NAMES only.
- **Total functions.** Missing dirs / malformed lines / malformed TOML degrade to empty/skip, never throw. Absent `~/.gemini` ⇒ the source contributes nothing.
- **Digest boundary.** References are lock-pinned (signed); `bindings` are the unsigned in-memory overlay.
- **TEST LOCATION.** Root Vitest only globs `dist/**/__tests__/**/*.test.js` compiled from the **root `src/` tree**. Every new test MUST live at `src/gem/__tests__/<name>.test.ts` and import the code under test from its published package (`@agentgem/model`, `@agentgem/insight`, `@agentgem/archive`), NOT via deep relative `../` paths. Confirm each new test is collected by root `pnpm test` (its `dist/gem/__tests__/<name>.test.js` must appear in the run).
- **Test command.** Root `pnpm test`. Tests run from compiled `dist/` — build before testing. NEVER pipe `pnpm test` through `tail` (it masks the exit code); redirect to a file and read the summary + `$?`.
- **Known flaky suites.** aggregator (`catalogShare`/`detection`/`sweepController`) + transfer (`seal`) crypto tests TIME OUT under load — not regressions. If the only failures are those, re-run them in isolation to confirm, then treat the run as green.
- **Commits.** Author `Raymond Feng <raymond@ninemind.ai>`; trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly + verify `git show HEAD`.

## Verified Gemini formats (from upstream `main`, v0.51.0-nightly)

- **Session file:** `~/.gemini/tmp/<slug>/chats/session-<ts>-<shortId>.jsonl`. Append-only, one JSON record per line. Scan glob: all `.jsonl` under `~/.gemini/tmp` whose basename starts with `session-` (this skips nested subagent files and legacy `.json`). Use the `<slug>` path segment as the `project` name.
- **Header line:** `{ sessionId, projectHash, startTime, lastUpdated, kind, directories }` (detected by having both `sessionId` and `projectHash`).
- **Message line:** `{ id, timestamp (ISO string), type: "user"|"gemini"|"info"|"error"|"warning", content }`; `gemini` messages also carry `tokens: { input, output, cached, thoughts?, tool?, total }` and `model`.
- **Mutation lines:** `{ "$rewindTo": "<messageId>" }` (delete that id AND every message after it; if id absent, clear all) and `{ "$set": { ...partial } }` (merge into metadata; if `$set.messages` is an array, clear the message map and rebuild from it — a checkpoint replace).
- **Fold (to reconstruct final state):** insertion-ordered `Map<id, msgRecord>`; a message line does `map.set(id, rec)` (re-set overwrites in place); `$rewindTo` deletes from the id inclusive; `$set.messages` array clears+rebuilds. Final messages = map values.
- **settings.json:** `mcpServers` keyed by name (stdio `command`/`args`/`env`/`cwd`; sse `url`+`type:"sse"`; http `httpUrl`/`headers`+`type:"http"`; `trust`/`includeTools`/`excludeTools`). Model at `model.name`.
- **commands/*.toml:** `{ prompt (required), description? }`. Command name = path relative to the commands dir, minus `.toml`, path-separators → `:` (e.g. `git/commit.toml` → `git:commit`).
- **GEMINI.md:** global `~/.gemini/GEMINI.md` + project `GEMINI.md`, concatenated.

### SessionStat mapping (Gemini → the existing neutral SessionStat)
- `agent: "gemini"`; `sessionId` = header `sessionId` else filename `shortId`; `project` = the `<slug>` dir segment; `model` = last `gemini` message's `model`; `gitBranch: null`.
- `startMs`/`endMs` = min/max of message `timestamp` (`Date.parse`), else header `startTime`/`lastUpdated`.
- `msgs` = count of final `user`+`gemini` records (skip info/error/warning).
- Tokens summed over final `gemini` records: `tokensIn = Σ max(0, input − cached)`, `tokensOut = Σ (output + (thoughts ?? 0))`, `tokensCache = Σ cached`. (Mirrors the codex mapping: fresh input excludes cache; reasoning-like `thoughts` folds into output.)

---

## File Structure

- `packages/model/src/publicPackage.ts` — **create**: exported `isPublicNpm`/`firstPackage`/`PUBLIC_SCOPES` (hoisted from cline.ts).
- `packages/model/src/index.ts` — **modify**: export the new util.
- `packages/insight/src/sources/cline.ts` — **modify**: import the hoisted classifier (delete the local copies).
- `packages/insight/src/sources/gemini.ts` — **create**: `parseGeminiSession`, `scanGeminiSessions`, `readGeminiArtifacts`.
- `packages/insight/src/sources.ts` — **modify**: add `geminiSource` to `BUILTIN_SOURCES`.
- `packages/insight/src/index.ts` — **modify**: export the gemini functions.
- `packages/model/src/targets.ts` — **modify**: add `gemini` to `TargetId` + `TARGET_REGISTRY` (3 renderers).
- Tests: `src/gem/__tests__/{gemini.scan,gemini.artifacts,gemini.source,targets.gemini,gemini.roundtrip}.test.ts`, plus updates to any test that hardcodes the source/target id lists.

---

## Task 1: Hoist the public-npm classifier to a shared util

Closes final-review carried-finding #2 before Gemini becomes a third copy. Pure refactor — no behavior change.

**Files:**
- Create: `packages/model/src/publicPackage.ts`
- Modify: `packages/model/src/index.ts` (export), `packages/insight/src/sources/cline.ts` (consume)
- Test: `src/gem/__tests__/publicPackage.test.ts`

**Interfaces:**
- Produces: `firstPackage(args: unknown): string | null`; `isPublicNpm(pkg: string): boolean`; `PUBLIC_SCOPES: Set<string>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/publicPackage.test.ts
import { describe, it, expect } from "vitest";
import { firstPackage, isPublicNpm } from "@agentgem/model";

describe("public-npm classifier", () => {
  it("takes the first non-flag arg", () => {
    expect(firstPackage(["-y", "@scope/pkg"])).toBe("@scope/pkg");
    expect(firstPackage(["pkg"])).toBe("pkg");
    expect(firstPackage("nope")).toBeNull();
  });
  it("classifies public vs private/path", () => {
    expect(isPublicNpm("@modelcontextprotocol/server-x")).toBe(true);
    expect(isPublicNpm("some-bare-pkg")).toBe(true);
    expect(isPublicNpm("@private/thing")).toBe(false); // scope not allowlisted
    expect(isPublicNpm("./local")).toBe(false);
    expect(isPublicNpm("/abs/path")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/model build && pnpm --filter @agentgem/model test publicPackage` (or build root + `pnpm test publicPackage`)
Expected: FAIL — `@agentgem/model` has no export `firstPackage`/`isPublicNpm`.

- [ ] **Step 3: Create the util** — move the exact logic currently in `packages/insight/src/sources/cline.ts` (`firstPackage`, `isPublicNpm`, `PUBLIC_SCOPES`) verbatim into a new file:

```ts
// packages/model/src/publicPackage.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Shared classifier: is an MCP stdio server a PUBLIC npm package (→ store as a package
// reference) or something local/private (→ embed with secrets redacted)? Hoisted from the
// Cline reader so every source adapter (Cline, Gemini, future Cursor) shares one security-
// relevant rule. Scoped packages default to private unless the scope is allowlisted.
export const PUBLIC_SCOPES = new Set(["@modelcontextprotocol"]);

/** First non-flag arg is the package spec (skips `-y` etc). */
export function firstPackage(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  for (const a of args) { if (typeof a === "string" && !a.startsWith("-")) return a; }
  return null;
}

export function isPublicNpm(pkg: string): boolean {
  if (pkg.startsWith("/") || pkg.startsWith(".")) return false; // filesystem path
  if (pkg.startsWith("@")) return PUBLIC_SCOPES.has(pkg.split("/")[0]);
  return /^[a-z0-9][a-z0-9._-]*$/i.test(pkg);
}
```
Export from `packages/model/src/index.ts`:
```ts
export * from "./publicPackage.js";
```

- [ ] **Step 4: Refactor cline.ts to consume it** — in `packages/insight/src/sources/cline.ts`, delete the local `PUBLIC_SCOPES`/`firstPackage`/`isPublicNpm` definitions and import them:
```ts
import { firstPackage, isPublicNpm } from "@agentgem/model";
```
Leave all call sites unchanged (same names).

- [ ] **Step 5: Build + run the new test AND the existing Cline tests (behavior unchanged)**

Run: `pnpm build && pnpm test publicPackage cline`
Expected: PASS — `publicPackage` collected + green; `cline.artifacts`/`cline.scan`/`cline.source`/`cline.roundtrip` all still green (proves the refactor changed nothing).

- [ ] **Step 6: Commit**

```bash
git add packages/model/src/publicPackage.ts packages/model/src/index.ts packages/insight/src/sources/cline.ts src/gem/__tests__/publicPackage.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "refactor(model): hoist public-npm classifier to shared util (cline consumes it)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Gemini session scan → SessionStat (the mutation-fold)

**Files:**
- Create: `packages/insight/src/sources/gemini.ts`
- Modify: `packages/insight/src/index.ts` (export)
- Test: `src/gem/__tests__/gemini.scan.test.ts`

**Interfaces:**
- Produces: `parseGeminiSession(jsonl: string, fallbackSessionId: string, project: string | null): SessionStat | null`; `scanGeminiSessions(files: string[]): Promise<SessionStat[]>`.

- [ ] **Step 1: Write the failing test** — proves the fold: a re-set message overwrites (not double-counts), and `$rewindTo` drops a message + everything after.

```ts
// src/gem/__tests__/gemini.scan.test.ts
import { describe, it, expect } from "vitest";
import { parseGeminiSession } from "@agentgem/insight";

const L = (o: unknown) => JSON.stringify(o);
// header, user m1, gemini m2 (tokens), gemini m2 RE-SET (updated tokens overwrite in place),
// user m3, gemini m4, then $rewindTo m3 (drops m3 AND m4).
const jsonl = [
  L({ sessionId: "sess-123", projectHash: "abc", startTime: "2026-07-01T00:00:00Z", lastUpdated: "2026-07-01T00:10:00Z", kind: "main" }),
  L({ id: "m1", timestamp: "2026-07-01T00:00:01Z", type: "user", content: "hi" }),
  L({ id: "m2", timestamp: "2026-07-01T00:00:02Z", type: "gemini", model: "gemini-2.5-pro", content: "x", tokens: { input: 5, output: 3, cached: 0, thoughts: 0, total: 8 } }),
  L({ id: "m2", timestamp: "2026-07-01T00:00:03Z", type: "gemini", model: "gemini-2.5-pro", content: "x", tokens: { input: 100, output: 40, cached: 10, thoughts: 4, total: 154 } }),
  L({ id: "m3", timestamp: "2026-07-01T00:05:00Z", type: "user", content: "again" }),
  L({ id: "m4", timestamp: "2026-07-01T00:05:01Z", type: "gemini", model: "gemini-2.5-pro", content: "y", tokens: { input: 999, output: 999, cached: 0, total: 1998 } }),
  L({ $rewindTo: "m3" }),
].join("\n");

describe("Gemini session fold", () => {
  it("folds re-set (overwrite) + $rewindTo (drop inclusive)", () => {
    const s = parseGeminiSession(jsonl, "fallback", "my-repo")!;
    expect(s).toMatchObject({ agent: "gemini", sessionId: "sess-123", project: "my-repo", model: "gemini-2.5-pro" });
    // survivors after rewind: m1 (user) + m2 (gemini, the RE-SET values). m3/m4 dropped.
    expect(s.msgs).toBe(2);
    expect(s.tokensIn).toBe(90);   // max(0, 100-10)
    expect(s.tokensOut).toBe(44);  // 40 + 4 thoughts
    expect(s.tokensCache).toBe(10);
    expect(s.startMs).toBe(Date.parse("2026-07-01T00:00:01Z"));
    expect(s.endMs).toBe(Date.parse("2026-07-01T00:00:03Z")); // m2's re-set ts (m3/m4 rewound away)
  });
  it("returns null for empty/malformed", () => {
    expect(parseGeminiSession("", "f", null)).toBeNull();
    expect(parseGeminiSession("not json\n{bad", "f", null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm test gemini.scan`
Expected: FAIL — `parseGeminiSession` not exported.

- [ ] **Step 3: Implement the parser + fold**

```ts
// packages/insight/src/sources/gemini.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Gemini CLI ingestion. Session files are append-only JSONL that MIX a header line, message
// lines, and mutation lines ($rewindTo / $set). To count messages + sum tokens correctly we
// replay the CLI's own fold: an insertion-ordered Map<id,msg>; a re-set id overwrites in place;
// $rewindTo deletes from the id inclusive; $set.messages is a checkpoint replace. Metadata only —
// never reads `content`. Total: malformed lines are skipped, a malformed file yields null.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { SessionStat } from "../observeAggregate.js";

interface GemTokens { input?: number; output?: number; cached?: number; thoughts?: number; tool?: number; total?: number }
interface GemMsg { id: string; timestamp?: string; type?: string; model?: string; tokens?: GemTokens }

function* lines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line) as Record<string, unknown>; } catch { /* skip malformed */ }
  }
}

export function parseGeminiSession(jsonl: string, fallbackSessionId: string, project: string | null): SessionStat | null {
  const map = new Map<string, GemMsg>();       // insertion-ordered survivors
  let sessionId = "", model: string | null = null;
  for (const rec of lines(jsonl)) {
    if (typeof rec.$rewindTo === "string") {    // drop the id AND everything after it
      const target = rec.$rewindTo;
      if (!map.has(target)) { map.clear(); continue; }
      let seen = false;
      for (const id of [...map.keys()]) { if (id === target) seen = true; if (seen) map.delete(id); }
      continue;
    }
    if (rec.$set && typeof rec.$set === "object") {    // metadata; a messages[] payload is a checkpoint replace
      const set = rec.$set as Record<string, unknown>;
      if (Array.isArray(set.messages)) { map.clear(); for (const m of set.messages as GemMsg[]) if (m && typeof m.id === "string") map.set(m.id, m); }
      continue;
    }
    if (typeof rec.sessionId === "string" && typeof rec.projectHash === "string") { sessionId = rec.sessionId; continue; } // header
    if (typeof rec.id === "string") {                  // message record
      const m = rec as unknown as GemMsg;
      map.set(m.id, m);
      if (m.type === "gemini" && typeof m.model === "string") model = m.model;
    }
  }
  const msgsArr = [...map.values()].filter((m) => m.type === "user" || m.type === "gemini");
  if (msgsArr.length === 0) return null;
  let startMs = Infinity, endMs = -Infinity, tokensIn = 0, tokensOut = 0, tokensCache = 0;
  for (const m of msgsArr) {
    const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
    if (!Number.isNaN(ts)) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); }
    if (m.type === "gemini" && m.tokens) {
      const t = m.tokens;
      tokensIn += Math.max(0, (t.input ?? 0) - (t.cached ?? 0));
      tokensOut += (t.output ?? 0) + (t.thoughts ?? 0);
      tokensCache += t.cached ?? 0;
    }
  }
  if (endMs < startMs) return null;
  return { agent: "gemini", sessionId: sessionId || fallbackSessionId, project, model, gitBranch: null, startMs, endMs, msgs: msgsArr.length, tokensIn, tokensOut, tokensCache };
}

// Derive the <slug> project from a `~/.gemini/tmp/<slug>/chats/...` path.
function slugOf(path: string): string | null {
  const m = path.match(/[/\\]tmp[/\\]([^/\\]+)[/\\]chats[/\\]/);
  return m ? m[1] : null;
}

export async function scanGeminiSessions(files: string[]): Promise<SessionStat[]> {
  const out: SessionStat[] = [];
  for (const f of files) {
    let text: string; try { text = await readFile(f, "utf8"); } catch { continue; }
    const fallback = basename(f).replace(/^session-/, "").replace(/\.jsonl$/, "");
    const s = parseGeminiSession(text, fallback, slugOf(f)); if (s) out.push(s);
  }
  return out;
}
```
Export from `packages/insight/src/index.ts`:
```ts
export * from "./sources/gemini.js";
```

- [ ] **Step 4: Build + run**

Run: `pnpm build && pnpm test gemini.scan`
Expected: PASS — `dist/gem/__tests__/gemini.scan.test.js` collected + green.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sources/gemini.ts packages/insight/src/index.ts src/gem/__tests__/gemini.scan.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): Gemini CLI session scan (JSONL mutation-fold)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Gemini artifact import (GEMINI.md + mcpServers + commands)

**Files:**
- Modify: `packages/insight/src/sources/gemini.ts` (append `readGeminiArtifacts`)
- Test: `src/gem/__tests__/gemini.artifacts.test.ts`

**Interfaces:**
- Consumes: `ImportResult` (`packages/insight/src/sources.ts`), `firstPackage`/`isPublicNpm` (Task 1), `GemArtifact`/`McpServerArtifact`/`ReferenceArtifact` (`@agentgem/model`).
- Produces: `readGeminiArtifacts(env: { contextFile?: string; settingsFile?: string; commandsDir?: string }): Promise<ImportResult>`.

**TOML note:** commands are TOML. Check the workspace for an available TOML parser dependency (e.g. `@iarna/toml`, `smol-toml`, or `toml`) — `git grep -l "toml" package.json` and check `pnpm ls`. If one is available to `@agentgem/insight`, use it. If none is, parse the two known fields (`prompt`, `description`) with a minimal reader that handles TOML basic (`"..."`), multi-line basic (`"""..."""`), and literal (`'''...'''`) strings — and note the limitation. Do NOT add a new dependency without checking first.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/gemini.artifacts.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGeminiArtifacts } from "@agentgem/insight";

describe("Gemini artifact import", () => {
  it("imports GEMINI.md, mcpServers (public npx → ref, private → redacted), commands → skills", async () => {
    const base = mkdtempSync(join(tmpdir(), "gem-"));
    writeFileSync(join(base, "GEMINI.md"), "Prefer concise diffs.");
    writeFileSync(join(base, "settings.json"), JSON.stringify({ model: { name: "gemini-2.5-pro" }, mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
      local: { command: "node", args: ["./s.js"], env: { TOKEN: "secret" } },
    } }));
    const cmds = join(base, "commands", "git"); mkdirSync(cmds, { recursive: true });
    writeFileSync(join(base, "commands", "git", "commit.toml"), 'prompt = "Write a commit for {{args}}"\ndescription = "commit helper"');

    const { artifacts, binding } = await readGeminiArtifacts({ contextFile: join(base, "GEMINI.md"), settingsFile: join(base, "settings.json"), commandsDir: join(base, "commands") });
    expect(artifacts.find((a) => a.type === "instructions")).toMatchObject({ content: "Prefer concise diffs." });
    expect(artifacts.find((a) => a.type === "reference")).toMatchObject({ refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } });
    const local = artifacts.find((a) => a.type === "mcp_server");
    expect(local).toMatchObject({ name: "local" });
    expect(JSON.stringify(local)).not.toContain("secret");                 // env redacted
    const skill = artifacts.find((a) => a.type === "skill");
    expect(skill).toMatchObject({ name: "git:commit", content: "Write a commit for {{args}}" });  // namespaced
    expect(binding).toMatchObject({ agent: "gemini", origin: "imported", model: "gemini-2.5-pro" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm test gemini.artifacts`
Expected: FAIL — `readGeminiArtifacts` not exported.

- [ ] **Step 3: Implement `readGeminiArtifacts`** — append to `gemini.ts`:

```ts
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { firstPackage, isPublicNpm } from "@agentgem/model";
import type { GemArtifact, McpServerArtifact, ReferenceArtifact } from "@agentgem/model";
import type { ImportResult } from "../sources.js";

// Minimal TOML field read for command files (prompt/description), handling """ / ''' / "" strings.
// If a workspace TOML parser is available, prefer it (see the plan's TOML note) and delete this.
function tomlField(text: string, key: string): string | null {
  const triple = text.match(new RegExp(`${key}\\s*=\\s*("""|''')([\\s\\S]*?)\\1`));
  if (triple) return triple[2];
  const basic = text.match(new RegExp(`${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (basic) return basic[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  return null;
}

function commandName(commandsDir: string, file: string): string {
  return relative(commandsDir, file).replace(/\.toml$/i, "").split(sep).join(":");
}

function listToml(dir: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[]; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listToml(p));
    else if (e.name.toLowerCase().endsWith(".toml")) out.push(p);
  }
  return out;
}

export async function readGeminiArtifacts(env: { contextFile?: string; settingsFile?: string; commandsDir?: string }): Promise<ImportResult> {
  const artifacts: GemArtifact[] = [];
  let model: string | undefined;

  if (env.contextFile) {
    try { const c = await readFile(env.contextFile, "utf8"); if (c.trim()) artifacts.push({ type: "instructions", name: "gemini", content: c }); } catch { /* absent */ }
  }
  if (env.settingsFile) {
    try {
      const s = JSON.parse(await readFile(env.settingsFile, "utf8")) as { model?: { name?: string }; mcpServers?: Record<string, { command?: string; args?: unknown; env?: unknown; url?: string; httpUrl?: string }> };
      if (typeof s.model?.name === "string") model = s.model.name;
      for (const [name, cfg] of Object.entries(s.mcpServers ?? {})) {
        const pkg = firstPackage(cfg.args);
        if (cfg.command === "npx" && pkg && isPublicNpm(pkg)) {
          artifacts.push({ type: "reference", name, refKind: "mcp_server", ref: { kind: "package", id: `npx:${pkg}` } } satisfies ReferenceArtifact);
        } else {
          const url = cfg.url ?? cfg.httpUrl;
          const server: McpServerArtifact = { type: "mcp_server", name, transport: url ? "http" : "stdio", config: url ? { url } : { command: cfg.command, args: cfg.args } };  // env redacted (allowlist copy)
          artifacts.push(server);
        }
      }
    } catch { /* absent/malformed */ }
  }
  if (env.commandsDir) {
    for (const file of listToml(env.commandsDir)) {
      let text: string; try { text = await readFile(file, "utf8"); } catch { continue; }
      const prompt = tomlField(text, "prompt");
      if (prompt == null) continue;                              // prompt is required
      const skill = { type: "skill" as const, name: commandName(env.commandsDir, file), source: "gemini-command", content: prompt };
      const desc = tomlField(text, "description"); if (desc != null) (skill as { description?: string }).description = desc;
      artifacts.push(skill);
    }
  }
  const binding = { agent: "gemini", origin: "imported" as const, ...(model ? { model } : {}) };
  return { artifacts, binding };
}
```

- [ ] **Step 4: Build + run**

Run: `pnpm build && pnpm test gemini.artifacts`
Expected: PASS. If a workspace TOML parser was available and used instead of `tomlField`, the assertions are unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sources/gemini.ts src/gem/__tests__/gemini.artifacts.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): Gemini artifact import (GEMINI.md + mcpServers + commands→skills)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Register the `gemini` SourceSpec

**Files:**
- Modify: `packages/insight/src/sources.ts`
- Test: `src/gem/__tests__/gemini.source.test.ts` + update the built-ins id-list assertion in `src/gem/__tests__/sources.test.ts` and the `SourceRegistry` count assertions in `src/gem/__tests__/sourceRegistry.test.ts`.

**Interfaces:**
- Consumes: `scanGeminiSessions`, `readGeminiArtifacts` (Tasks 2–3).
- Produces: `geminiSource: SourceSpec` in `BUILTIN_SOURCES` (`id:"gemini"`, `traits.storage:"jsonl"`).

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/gemini.source.test.ts
import { describe, it, expect } from "vitest";
import { BUILTIN_SOURCES } from "@agentgem/insight";

describe("gemini SourceSpec", () => {
  it("is registered with jsonl storage and a scan face", () => {
    const g = BUILTIN_SOURCES.find((s) => s.id === "gemini");
    expect(g?.traits.storage).toBe("jsonl");
    expect(typeof g?.scanSessions).toBe("function");
    expect(typeof g?.readArtifacts).toBe("function");
  });
  it("absent ~/.gemini yields [] sessions, never throws", async () => {
    const g = BUILTIN_SOURCES.find((s) => s.id === "gemini")!;
    await expect(g.scanSessions!(g.roots({ baseDir: "/no/such" }))).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm test gemini.source`
Expected: FAIL — no `gemini` in `BUILTIN_SOURCES`.

- [ ] **Step 3: Add `geminiSource`** — in `packages/insight/src/sources.ts`:

```ts
import { scanGeminiSessions, readGeminiArtifacts } from "./sources/gemini.js";
import { homedir } from "node:os"; // if not already imported

// Session files live under ~/.gemini/tmp/<slug>/chats/session-*.jsonl. baseDir overrides for tests
// and points at a ~/.gemini root. We glob all .jsonl under tmp and keep the `session-`-prefixed ones.
function geminiTmpDir(baseDir?: string): string {
  return join(baseDir ?? join(homedir(), ".gemini"), "tmp");
}

const geminiSource: SourceSpec = {
  id: "gemini", label: "Gemini CLI", traits: { storage: "jsonl" },
  roots: (env) => [geminiTmpDir(env.baseDir)],
  scanSessions: (roots) =>
    scanGeminiSessions(roots.flatMap((r) => listFiles(r, ".jsonl")).filter((f) => basename(f).startsWith("session-"))),
  readArtifacts: async () => readGeminiArtifacts({}),  // per-repo file paths supplied by callers in a later phase (mirrors cline)
};
```
Add `geminiSource` to the `BUILTIN_SOURCES` array.

- [ ] **Step 4: Update the hardcoded id-list assertions** — adding a 4th source breaks two existing tests:
- `src/gem/__tests__/sources.test.ts`: the `expect(BUILTIN_SOURCES.map((s) => s.id).sort()).toEqual([...])` must become `["claude", "cline", "codex", "gemini"]` (sorted).
- `src/gem/__tests__/sourceRegistry.test.ts`: `r.all()` length `3→4`, `defaultSourceRegistry.all().length` `3→4`, the wired-container `all().length` `4→5`, and any id-list. Update the counts/lists to match the real registration order `[claude, codex, cline, gemini]` — do NOT weaken assertions.

- [ ] **Step 5: Build + run the source + registry tests**

Run: `pnpm build && pnpm test gemini.source sources sourceRegistry`
Expected: PASS (all updated assertions green).

- [ ] **Step 6: Commit**

```bash
git add packages/insight/src/sources.ts src/gem/__tests__/gemini.source.test.ts src/gem/__tests__/sources.test.ts src/gem/__tests__/sourceRegistry.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): register gemini SourceSpec

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Gemini `TargetSpec` (materialize into ~/.gemini layout)

**Files:**
- Modify: `packages/model/src/targets.ts` (add `"gemini"` to `TargetId` + 3 renderers + registry entry)
- Test: `src/gem/__tests__/targets.gemini.test.ts` + add `"gemini"` to the hardcoded target lists in `src/__tests__/schemas.test.ts` and `src/gem/__tests__/targets.test.ts`.

**Interfaces:**
- Consumes: `Gem`, `materialize` (existing).
- Produces: `TARGET_REGISTRY.gemini` — `instructions` → `GEMINI.md`, `skill` → `.gemini/commands/<name>.toml`, `mcp` → `.gemini/settings.json`.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/targets.gemini.test.ts
import { describe, it, expect } from "vitest";
import { materialize } from "@agentgem/model";
import type { Gem } from "@agentgem/model";

const gem: Gem = { name: "g", createdFrom: "t", checks: [], requiredSecrets: [], artifacts: [
  { type: "instructions", name: "ctx", content: "Be concise." },
  { type: "skill", name: "git:commit", source: "gemini-command", content: "Write a commit for {{args}}" },
  { type: "mcp_server", name: "local", transport: "stdio", config: { command: "node", args: ["s.js"] } },
  { type: "reference", name: "context7", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } },
] };

describe("gemini target", () => {
  it("writes GEMINI.md, a namespaced command TOML, and settings.json mcpServers (ref as npx)", () => {
    const { files } = materialize(gem, "gemini");
    expect(files["GEMINI.md"]).toBe("Be concise.");
    expect(files[".gemini/commands/git/commit.toml"]).toContain("Write a commit for {{args}}");
    const settings = JSON.parse(files[".gemini/settings.json"]);
    expect(settings.mcpServers.local).toMatchObject({ command: "node", args: ["s.js"] });
    expect(settings.mcpServers.context7).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/model build && pnpm test targets.gemini`
Expected: FAIL — `"gemini"` not a `TargetId`.

- [ ] **Step 3: Implement the target** — in `packages/model/src/targets.ts`:
- Widen `TargetId`: add `| "gemini"`.
- Add renderers near the other target renderers:
```ts
const instructionsGeminiMd = (all: InstructionsArtifact[]): FileTree => ({ "GEMINI.md": all.map((i) => i.content).join("\n\n") });
// skill name is a namespaced command id (git:commit) -> commands/git/commit.toml. `:` -> path sep.
const skillGeminiCommand = (a: SkillArtifact): FileTree => {
  const rel = a.name.split(":").map(safePathSegment).join("/");
  // Literal TOML string ''' preserves the prompt verbatim (no escaping); guard the rare ''' case.
  const body = a.content.includes("'''") ? JSON.stringify(a.content) : `'''${a.content}'''`;
  const desc = a.description ? `\ndescription = ${JSON.stringify(a.description)}` : "";
  return { [`.gemini/commands/${rel}.toml`]: `prompt = ${body}${desc}\n` };
};
const mcpGeminiSettings = (servers: McpServerArtifact[]): MaterializeResult => {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) mcpServers[s.name] = s.config;   // already redacted at import
  return rendered({ ".gemini/settings.json": JSON.stringify({ mcpServers }, null, 2) });
};
```
- Add to `TARGET_REGISTRY`:
```ts
  gemini: { id: "gemini", label: "Gemini CLI", skill: skillGeminiCommand, instructions: instructionsGeminiMd, mcp: mcpGeminiSettings },
```
> The package reference reaches `mcp` via the Task-3 reference-batching block in `materialize` (resolves to an npx `McpServerArtifact`, batched into one `spec.mcp(...)` call), so `context7` renders as an npx command — verify in Step 4.

- [ ] **Step 4: Update hardcoded target lists + build + run**
- `src/__tests__/schemas.test.ts` and `src/gem/__tests__/targets.test.ts` hardcode the full target-id list / compatibility record — insert `"gemini"` in the correct (alphabetical) position.

Run: `pnpm build && pnpm test targets.gemini targets schemas`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/targets.ts src/gem/__tests__/targets.gemini.test.ts src/__tests__/schemas.test.ts src/gem/__tests__/targets.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(model): gemini materialize target (GEMINI.md + settings.json + commands)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Round-trip integration proof

**Files:**
- Test: `src/gem/__tests__/gemini.roundtrip.test.ts`

**Interfaces:**
- Consumes: `readGeminiArtifacts` (Task 3), `materialize` (Task 5), `writeGemArchive`/`readGemArchive` (`@agentgem/archive`).

- [ ] **Step 1: Write the round-trip test**

```ts
// src/gem/__tests__/gemini.roundtrip.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGeminiArtifacts } from "@agentgem/insight";
import { materialize } from "@agentgem/model";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

describe("Gemini round-trip: import -> Gem -> archive -> materialize back", () => {
  it("reproduces GEMINI.md, command, and MCP (package ref as npx); binding is dropped by the archive", async () => {
    const base = mkdtempSync(join(tmpdir(), "gemrt-"));
    writeFileSync(join(base, "GEMINI.md"), "Small, verifiable steps.");
    writeFileSync(join(base, "settings.json"), JSON.stringify({ model: { name: "gemini-2.5-pro" }, mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
    } }));
    mkdirSync(join(base, "commands", "git"), { recursive: true });
    writeFileSync(join(base, "commands", "git", "commit.toml"), 'prompt = "Commit for {{args}}"');

    const { artifacts, binding } = await readGeminiArtifacts({ contextFile: join(base, "GEMINI.md"), settingsFile: join(base, "settings.json"), commandsDir: join(base, "commands") });
    const gem: Gem = { name: "imported", createdFrom: "gemini", artifacts, checks: [], requiredSecrets: [], bindings: [binding] };

    const back = readGemArchive(writeGemArchive(gem).files);
    expect(back.artifacts).toEqual(gem.artifacts);          // references survive the signed archive
    expect(back.bindings).toBeUndefined();                  // binding is an in-memory overlay only

    const { files } = materialize(back, "gemini");
    expect(files["GEMINI.md"]).toBe("Small, verifiable steps.");
    expect(files[".gemini/commands/git/commit.toml"]).toContain("Commit for {{args}}");
    expect(JSON.parse(files[".gemini/settings.json"]).mcpServers.context7).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
```

- [ ] **Step 2: Run it (should pass; if it fails, a real cross-task seam is broken — report, don't weaken)**

Run: `pnpm build && pnpm test gemini.roundtrip`
Expected: PASS. In particular the command round-trips (import parses `prompt` from TOML → skill.content → target emits `'''...'''` → matches). If the TOML emit/parse aren't inverse, THIS is where it surfaces — fix the parser/emitter, not the assertion.

- [ ] **Step 3: Full suite**

Run (redirect, do not pipe through tail): `pnpm test > /tmp/gem-suite.log 2>&1; echo $?` then read the summary. Only the known aggregator/transfer crypto flakes may fail under load — verify those in isolation.
Expected: green (Gemini + model/insight/archive all pass).

- [ ] **Step 4: Commit**

```bash
git add src/gem/__tests__/gemini.roundtrip.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "test(insight): Gemini import->gem->archive->materialize round-trip proof

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** classifier hoist / finding #2 (Task 1); session scan with the verified mutation-fold (Task 2); symmetric import of all three artifact classes — GEMINI.md, mcpServers→mcp/refs, commands→skills (Task 3); registration (Task 4); materialize target (Task 5); round-trip proof (Task 6). Symmetric source+target per the scope decision.
- **Type consistency:** `SessionStat` shape matches `observeAggregate.ts`; `ReferenceArtifact`/`McpServerArtifact` per `@agentgem/model`; `ImportResult` per `sources.ts`; `AgentBinding` gains an optional `model` (already in the type). The command-name mapping (`:`↔`/`) is inverse between import (`commandName`) and target (`skillGeminiCommand`), which the round-trip test pins.
- **Known deferrals (consistent with the Cline pass):** `geminiSource.readArtifacts` is the same registry stub as Cline (per-repo file paths wired in a later phase); the compose/publish reference-drop paths (carried-finding #3) remain out of scope.

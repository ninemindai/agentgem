# Continue.dev Adapter Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a symmetric Continue.dev adapter (source + target) on the multi-agent-sources abstraction, proven with a round-trip.

**Architecture:** A `continue` `SourceSpec` (session scan from `~/.continue/sessions`; artifact import from `config.yaml`) and a `continue` `TargetSpec` that uses the `compose` hook to render a Gem into a single native `config.yaml`, registered on the existing `AGENT_SOURCES`/`TARGET_REGISTRY`. Pure plug-in on the merged abstraction (Cline + Gemini already landed on `main`).

**Tech Stack:** TypeScript (ESM, `.js` suffixes), pnpm workspaces, Vitest, `@agentgem/model`/`@agentgem/insight`/`@agentgem/archive`, `yaml@^2` (new direct dep — see below).

**Base branch:** `continue-source`, off fresh `origin/main` (which contains the full abstraction + Cline + Gemini adapters — no stacking).

## New dependency

`yaml@^2` (the `yaml` package by eemeli) is added as a direct dependency of `@agentgem/insight` (config.yaml parse) and `@agentgem/model` (config.yaml emit). Justification: Continue's config is YAML (`config.yaml` is the current primary format; `config.json` is legacy), and YAML cannot be safely regex-parsed. `yaml@2` is already resolved transitively in `pnpm-lock.yaml`, so declaring it direct pulls no new download; it supports both `parse` and `stringify`. Do NOT add any other new dependency.

## Global Constraints

- **Privacy — metadata only.** Session scanning reads timing/token/model-title/role/id/workspaceDirectory ONLY — never message `content` and never the session `title` (it is a content-derived summary).
- **Secrets never ingested.** MCP `env`/`apiKey`/`requestOptions.headers` redacted on import (allowlist copy of the transport fields, never spread the raw server object); a binding's `secretMap` holds env-var NAMES only.
- **Total functions.** Missing dirs / malformed JSON / malformed YAML degrade to empty/skip, never throw. Absent `~/.continue` ⇒ the source contributes nothing.
- **Digest boundary.** References lock-pinned (signed); `bindings` unsigned in-memory overlay.
- **TEST LOCATION.** Root Vitest only globs `dist/**/__tests__/**/*.test.js` compiled from the **root `src/` tree**. Every new test MUST live at `src/gem/__tests__/<name>.test.ts` and import from the published packages (`@agentgem/model`, `@agentgem/insight`, `@agentgem/archive`), NOT deep `../` paths. Confirm each new test is collected by root `pnpm test`.
- **Test command.** Root `pnpm test`; tests run from compiled `dist/` — build before testing. NEVER pipe `pnpm test` through `tail` (masks exit code); redirect to a file, read the summary + `$?`.
- **Known flaky suites.** aggregator (`catalogShare`/`detection`/`sweepController`) + transfer (`seal`) + occasionally `authInstall` crypto tests TIME OUT under load — not regressions. If the only failures are those, re-run them in isolation to confirm, then treat green.
- **Commits.** Author `Raymond Feng <raymond@ninemind.ai>`; trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly + verify `git show HEAD`.

## Verified Continue formats (upstream `main` @ d0a3c0b)

- **Sessions:** index `~/.continue/sessions/sessions.json` = JSON array of `{ sessionId, title, dateCreated (String(ms-epoch)), workspaceDirectory, messageCount? }`. Per-session `~/.continue/sessions/<sessionId>.json` = `{ sessionId, title, workspaceDirectory, history[], mode?, chatModelTitle?, usage? }`.
  - `usage?: { completionTokens, promptTokens, promptTokensDetails?: { cachedTokens? }, ... , totalCost }` — OPTIONAL (absent on old/interrupted sessions).
  - `history[]` items: `{ message: {role, content}, ... }`; assistant messages may carry `usage?`. **No per-message wall-clock timestamp** exists in the session file (only `reasoning.startAt/endAt`).
  - So: `sessionId`/`chatModelTitle`/`messageCount`/`usage` come from the files; **start time** = index `dateCreated`; **end time** has no in-file source → use the `<id>.json` file **mtime** as the end proxy.
- **config.yaml** (`~/.continue/config.yaml`, legacy `config.json`): required top-level `name` + `version`. `mcpServers` = **ARRAY** of `{ name (required), command?, args?, env?, cwd?, url?, type?, apiKey?, requestOptions? }` (NOT an object-map). `models` = array of `{ name, provider, model, roles? }`. `rules` = array of `string | { name, rule, description?, globs? }`. `prompts` = array of `{ name, prompt, description? }`.
- `tokensGenerated` dev_data events have NO `sessionId` — that's why we scan session files, not dev_data.

### SessionStat mapping (Continue → neutral SessionStat)
- `agent: "continue"`; `sessionId` = `Session.sessionId` (or filename); `project` = `basename(workspaceDirectory)` or null; `model` = `chatModelTitle ?? null`; `gitBranch: null`.
- `startMs` = `parseInt(index.dateCreated, 10)` (ms-epoch); `endMs` = the session file's `mtimeMs` (last-write proxy); if `endMs < startMs`, clamp `endMs = startMs`.
- `msgs` = `index.messageCount` if present, else count `history[]` items whose `message.role` is `"user"` or `"assistant"`.
- Tokens from `Session.usage` when present: `tokensCache = usage.promptTokensDetails?.cachedTokens ?? 0`; `tokensIn = max(0, usage.promptTokens − tokensCache)`; `tokensOut = usage.completionTokens`. If `usage` absent, sum per-assistant-message `usage` the same way; if none, all zero.

---

## File Structure

- `packages/insight/src/sources/continue.ts` — **create**: `parseContinueSession`, `scanContinueSessions`, `readContinueArtifacts`.
- `packages/insight/src/index.ts` — **modify**: export the continue functions.
- `packages/insight/package.json` — **modify**: add `yaml@^2` dep.
- `packages/insight/src/sources.ts` — **modify**: add `continueSource` to `BUILTIN_SOURCES`.
- `packages/model/src/targets.ts` — **modify**: add `continue` to `TargetId` + `TARGET_REGISTRY` (a `compose` renderer).
- `packages/model/package.json` — **modify**: add `yaml@^2` dep.
- Tests: `src/gem/__tests__/{continue.scan,continue.artifacts,continue.source,targets.continue,continue.roundtrip}.test.ts`, plus id-list updates in `sources.test.ts`, `sourceRegistry.test.ts`, `targets.test.ts`, `schemas.test.ts`.

> Note: `continue` is a JS reserved word — the source module is named `continue.ts` (fine as a filename) but do NOT name any binding/variable `continue`; use `continueSource`, `readContinueArtifacts`, etc.

---

## Task 1: Continue session scan → SessionStat

**Files:**
- Create: `packages/insight/src/sources/continue.ts`
- Modify: `packages/insight/src/index.ts` (export)
- Test: `src/gem/__tests__/continue.scan.test.ts`

**Interfaces:**
- Produces: `parseContinueSession(sessionJson: string, meta: { dateCreated?: string; messageCount?: number; mtimeMs: number }): SessionStat | null`; `scanContinueSessions(sessionsDir: string): Promise<SessionStat[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/continue.scan.test.ts
import { describe, it, expect } from "vitest";
import { parseContinueSession } from "@agentgem/insight";

const session = JSON.stringify({
  sessionId: "s-1", title: "Refactor the parser", workspaceDirectory: "/home/u/my-proj",
  chatModelTitle: "Claude Sonnet 5",
  history: [
    { message: { role: "user", content: "hi" } },
    { message: { role: "assistant", content: "hello" } },
  ],
  usage: { promptTokens: 120, completionTokens: 45, promptTokensDetails: { cachedTokens: 20 }, totalCost: 0.01 },
});

describe("Continue session parse", () => {
  it("maps usage/model/timing into a SessionStat (title never leaks)", () => {
    const s = parseContinueSession(session, { dateCreated: "1751328000000", messageCount: 2, mtimeMs: 1751328600000 })!;
    expect(s).toMatchObject({ agent: "continue", sessionId: "s-1", project: "my-proj", model: "Claude Sonnet 5", msgs: 2 });
    expect(s.tokensIn).toBe(100);   // 120 - 20 cached
    expect(s.tokensOut).toBe(45);
    expect(s.tokensCache).toBe(20);
    expect(s.startMs).toBe(1751328000000);
    expect(s.endMs).toBe(1751328600000);         // file mtime proxy
    expect(JSON.stringify(s)).not.toContain("Refactor the parser"); // title is content-derived — never ingested
  });
  it("counts history when messageCount absent; zero tokens when usage absent; never throws on garbage", () => {
    const noUsage = JSON.stringify({ sessionId: "s-2", workspaceDirectory: "/p", history: [{ message: { role: "user", content: "x" } }] });
    const s = parseContinueSession(noUsage, { dateCreated: "1000", mtimeMs: 2000 })!;
    expect(s.msgs).toBe(1); expect(s.tokensIn).toBe(0); expect(s.tokensOut).toBe(0);
    expect(parseContinueSession("not json", { mtimeMs: 5 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm test continue.scan`
Expected: FAIL — `parseContinueSession` not exported.

- [ ] **Step 3: Implement the parser**

```ts
// packages/insight/src/sources/continue.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Continue.dev ingestion. Sessions are plain JSON: an index (sessions.json) of metadata + one
// <sessionId>.json per session carrying history + an optional `usage` token block + chatModelTitle.
// Continue records NO per-message timestamp, so start time comes from the index `dateCreated`
// (ms-epoch) and end time from the session file mtime. Metadata only — never reads message
// `content` and never the session `title` (a content-derived summary). Total: malformed → null/skip.
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { SessionStat } from "../observeAggregate.js";

interface CUsage { promptTokens?: number; completionTokens?: number; promptTokensDetails?: { cachedTokens?: number } }
interface CSession { sessionId?: string; workspaceDirectory?: string; chatModelTitle?: string | null;
  history?: { message?: { role?: string; usage?: CUsage } }[]; usage?: CUsage }

function tokensFrom(u: CUsage | undefined): { in: number; out: number; cache: number } {
  const cache = u?.promptTokensDetails?.cachedTokens ?? 0;
  return { in: Math.max(0, (u?.promptTokens ?? 0) - cache), out: u?.completionTokens ?? 0, cache };
}

export function parseContinueSession(
  sessionJson: string,
  meta: { dateCreated?: string; messageCount?: number; mtimeMs: number },
): SessionStat | null {
  let s: CSession;
  try { s = JSON.parse(sessionJson) as CSession; } catch { return null; }
  if (!s || typeof s !== "object") return null;
  const history = Array.isArray(s.history) ? s.history : [];
  const msgs = meta.messageCount ?? history.filter((h) => h.message?.role === "user" || h.message?.role === "assistant").length;
  if (msgs === 0 && !s.sessionId) return null;

  let tIn = 0, tOut = 0, tCache = 0;
  if (s.usage) { const t = tokensFrom(s.usage); tIn = t.in; tOut = t.out; tCache = t.cache; }
  else for (const h of history) if (h.message?.role === "assistant" && h.message.usage) { const t = tokensFrom(h.message.usage); tIn += t.in; tOut += t.out; tCache += t.cache; }

  const startMs = meta.dateCreated ? parseInt(meta.dateCreated, 10) : meta.mtimeMs;
  const endMs = Math.max(meta.mtimeMs, startMs);
  return {
    agent: "continue", sessionId: s.sessionId ?? "", project: s.workspaceDirectory ? basename(s.workspaceDirectory) : null,
    model: s.chatModelTitle ?? null, gitBranch: null,
    startMs: Number.isNaN(startMs) ? endMs : startMs, endMs, msgs, tokensIn: tIn, tokensOut: tOut, tokensCache: tCache,
  };
}

export async function scanContinueSessions(sessionsDir: string): Promise<SessionStat[]> {
  let indexRaw: string;
  try { indexRaw = await readFile(join(sessionsDir, "sessions.json"), "utf8"); } catch { return []; }
  let index: { sessionId?: string; dateCreated?: string; messageCount?: number }[];
  try { index = JSON.parse(indexRaw) as typeof index; } catch { return []; }
  if (!Array.isArray(index)) return [];
  const byId = new Map(index.filter((e) => e && typeof e.sessionId === "string").map((e) => [e.sessionId!, e]));

  const out: SessionStat[] = [];
  let files: string[]; try { files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json") && f !== "sessions.json"); } catch { return out; }
  for (const f of files) {
    const path = join(sessionsDir, f);
    let text: string, mtimeMs: number;
    try { text = await readFile(path, "utf8"); mtimeMs = (await stat(path)).mtimeMs; } catch { continue; }
    const id = basename(f, ".json");
    const e = byId.get(id);
    const stat_ = parseContinueSession(text, { dateCreated: e?.dateCreated, messageCount: e?.messageCount, mtimeMs });
    if (stat_) { if (!stat_.sessionId) stat_.sessionId = id; out.push(stat_); }
  }
  return out;
}
```
Export from `packages/insight/src/index.ts`:
```ts
export * from "./sources/continue.js";
```

- [ ] **Step 4: Build + run**

Run: `pnpm build && pnpm test continue.scan`
Expected: PASS — `dist/gem/__tests__/continue.scan.test.js` collected + green.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sources/continue.ts packages/insight/src/index.ts src/gem/__tests__/continue.scan.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): Continue.dev session scan (sessions.json + per-session usage)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Continue artifact import (config.yaml) + `yaml` dep

**Files:**
- Modify: `packages/insight/src/sources/continue.ts` (append `readContinueArtifacts`), `packages/insight/package.json` (add `yaml`)
- Test: `src/gem/__tests__/continue.artifacts.test.ts`

**Interfaces:**
- Consumes: `ImportResult` (`packages/insight/src/sources.ts`), `firstPackage`/`isPublicNpm` (`@agentgem/model`), `GemArtifact`/`McpServerArtifact`/`ReferenceArtifact` (`@agentgem/model`).
- Produces: `readContinueArtifacts(env: { configFile?: string }): Promise<ImportResult>`.

- [ ] **Step 1: Add the dep** — in `packages/insight/package.json` `dependencies`, add `"yaml": "^2"`. Run `pnpm install` (it's already in the lockfile transitively; this only declares it direct). Import in continue.ts: `import { parse as parseYaml } from "yaml";`. The config may be YAML or legacy JSON — try `parseYaml` (which also parses JSON, since JSON is valid YAML), so one parser covers both.

- [ ] **Step 2: Write the failing test**

```ts
// src/gem/__tests__/continue.artifacts.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContinueArtifacts } from "@agentgem/insight";

const yaml = `
name: my-assistant
version: 0.0.1
models:
  - name: Sonnet
    provider: anthropic
    model: claude-sonnet-5
    roles: [chat]
mcpServers:
  - name: context7
    command: npx
    args: ["-y", "@modelcontextprotocol/server-context7"]
  - name: local
    command: node
    args: ["./s.js"]
    env: { TOKEN: "secret" }
rules:
  - "Always write tests first."
  - name: style
    rule: "Prefer small diffs."
prompts:
  - name: commit
    prompt: "Write a commit for {{{ input }}}"
    description: commit helper
`;

describe("Continue artifact import", () => {
  it("imports mcpServers(array)→ref/redacted, rules→instructions, prompts→skills", async () => {
    const base = mkdtempSync(join(tmpdir(), "cont-"));
    writeFileSync(join(base, "config.yaml"), yaml);
    const { artifacts, binding } = await readContinueArtifacts({ configFile: join(base, "config.yaml") });

    expect(artifacts.find((a) => a.type === "reference")).toMatchObject({ refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } });
    const local = artifacts.find((a) => a.type === "mcp_server");
    expect(local).toMatchObject({ name: "local" });
    expect(JSON.stringify(local)).not.toContain("secret");   // env redacted
    const instr = artifacts.filter((a) => a.type === "instructions").map((a) => a.content);
    expect(instr).toContain("Always write tests first.");
    expect(instr).toContain("Prefer small diffs.");
    const skill = artifacts.find((a) => a.type === "skill");
    expect(skill).toMatchObject({ name: "commit", content: "Write a commit for {{{ input }}}" });
    expect(binding).toMatchObject({ agent: "continue", origin: "imported", model: "claude-sonnet-5" });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm test continue.artifacts`
Expected: FAIL — `readContinueArtifacts` not exported.

- [ ] **Step 4: Implement `readContinueArtifacts`** — append to `continue.ts`:

```ts
import { parse as parseYaml } from "yaml";
import { firstPackage, isPublicNpm } from "@agentgem/model";
import type { GemArtifact, McpServerArtifact, ReferenceArtifact } from "@agentgem/model";
import type { ImportResult } from "../sources.js";

interface CConfig {
  models?: { name?: string; model?: string; roles?: string[] }[];
  mcpServers?: { name?: string; command?: string; args?: unknown; env?: unknown; url?: string; type?: string }[];
  rules?: (string | { name?: string; rule?: string })[];
  prompts?: { name?: string; prompt?: string; description?: string }[];
}

export async function readContinueArtifacts(env: { configFile?: string }): Promise<ImportResult> {
  const artifacts: GemArtifact[] = [];
  let model: string | undefined;
  if (env.configFile) {
    try {
      const cfg = (parseYaml(await readFile(env.configFile, "utf8")) ?? {}) as CConfig;   // parseYaml also handles JSON
      // model for the binding: the chat-role model's id, else the first model's id.
      const chat = (cfg.models ?? []).find((m) => Array.isArray(m.roles) && m.roles.includes("chat")) ?? (cfg.models ?? [])[0];
      if (chat && typeof chat.model === "string") model = chat.model;

      for (const srv of cfg.mcpServers ?? []) {
        if (!srv || typeof srv.name !== "string") continue;
        const pkg = firstPackage(srv.args);
        if (srv.command === "npx" && pkg && isPublicNpm(pkg)) {
          artifacts.push({ type: "reference", name: srv.name, refKind: "mcp_server", ref: { kind: "package", id: `npx:${pkg}` } } satisfies ReferenceArtifact);
        } else {
          const server: McpServerArtifact = { type: "mcp_server", name: srv.name, transport: srv.url ? "http" : "stdio", config: srv.url ? { url: srv.url } : { command: srv.command, args: srv.args } };  // env dropped
          artifacts.push(server);
        }
      }
      let ri = 0;
      for (const r of cfg.rules ?? []) {
        if (typeof r === "string") { if (r.trim()) artifacts.push({ type: "instructions", name: `rule-${++ri}`, content: r }); }
        else if (r && typeof r.rule === "string") artifacts.push({ type: "instructions", name: r.name ?? `rule-${++ri}`, content: r.rule });
      }
      for (const p of cfg.prompts ?? []) {
        if (p && typeof p.name === "string" && typeof p.prompt === "string") {
          const skill = { type: "skill" as const, name: p.name, source: "continue-prompt", content: p.prompt };
          if (typeof p.description === "string") (skill as { description?: string }).description = p.description;
          artifacts.push(skill);
        }
      }
    } catch { /* absent/malformed */ }
  }
  const binding = { agent: "continue", origin: "imported" as const, ...(model ? { model } : {}) };
  return { artifacts, binding };
}
```

- [ ] **Step 5: Build + run**

Run: `pnpm build && pnpm test continue.artifacts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/insight/src/sources/continue.ts packages/insight/package.json pnpm-lock.yaml src/gem/__tests__/continue.artifacts.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): Continue artifact import (config.yaml rules/mcpServers/prompts) + yaml dep

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Register the `continue` SourceSpec

**Files:**
- Modify: `packages/insight/src/sources.ts`
- Test: `src/gem/__tests__/continue.source.test.ts` + update the id-list assertion in `src/gem/__tests__/sources.test.ts` and the counts in `src/gem/__tests__/sourceRegistry.test.ts`.

**Interfaces:**
- Consumes: `scanContinueSessions`, `readContinueArtifacts` (Tasks 1–2).
- Produces: `continueSource: SourceSpec` in `BUILTIN_SOURCES` (`id:"continue"`, `traits.storage:"json"`).

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/continue.source.test.ts
import { describe, it, expect } from "vitest";
import { BUILTIN_SOURCES } from "@agentgem/insight";

describe("continue SourceSpec", () => {
  it("is registered with json storage and both faces", () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "continue");
    expect(c?.traits.storage).toBe("json");
    expect(typeof c?.scanSessions).toBe("function");
    expect(typeof c?.readArtifacts).toBe("function");
  });
  it("absent ~/.continue yields [] sessions, never throws", async () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "continue")!;
    await expect(c.scanSessions!(c.roots({ baseDir: "/no/such" }))).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm test continue.source`
Expected: FAIL — no `continue` in `BUILTIN_SOURCES`.

- [ ] **Step 3: Add `continueSource`** — in `packages/insight/src/sources.ts`:

```ts
import { scanContinueSessions, readContinueArtifacts } from "./sources/continue.js";
// homedir already imported for the other sources.

// ~/.continue/sessions holds the session index + per-session JSON. baseDir overrides for tests
// (points at a ~/.continue root). scanSessions takes the sessions dir (one root).
function continueSessionsDir(baseDir?: string): string {
  return join(baseDir ?? join(homedir(), ".continue"), "sessions");
}

const continueSource: SourceSpec = {
  id: "continue", label: "Continue", traits: { storage: "json" },
  roots: (env) => [continueSessionsDir(env.baseDir)],
  scanSessions: async (roots) => (await Promise.all(roots.map((r) => scanContinueSessions(r)))).flat(),
  readArtifacts: async () => readContinueArtifacts({}),   // per-repo config path supplied by callers later (mirrors cline/gemini)
};
```
Add `continueSource` to `BUILTIN_SOURCES` (order: `[claude, codex, cline, gemini, continue]`).

- [ ] **Step 4: Update the hardcoded id-list assertions** (adding a 5th source):
- `src/gem/__tests__/sources.test.ts`: the sorted id-list `.toEqual(...)` → `["claude", "cline", "codex", "continue", "gemini"]` (sorted).
- `src/gem/__tests__/sourceRegistry.test.ts`: `r.all()` id-list → `["claude", "codex", "cline", "gemini", "continue"]` (registration order); `r.all()` length `4→5`; `defaultSourceRegistry.all().length` `4→5`; the wired-container `all().length` `5→6` (5 built-ins + 1 plugin). Read the current values and update exactly — do NOT weaken (`toEqual`/`toBe` stay).

- [ ] **Step 5: Build + run**

Run: `pnpm build && pnpm test continue.source sources sourceRegistry`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/insight/src/sources.ts src/gem/__tests__/continue.source.test.ts src/gem/__tests__/sources.test.ts src/gem/__tests__/sourceRegistry.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): register continue SourceSpec

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Continue `TargetSpec` (compose → single config.yaml) + `yaml` dep

Continue's native setup is ONE `config.yaml` holding models/mcpServers/rules/prompts, so this target uses the `compose` hook (whole-gem → one file), not per-artifact-type renderers. It must resolve package references itself (compose does not get the materialize reference-batching), so `context7` renders as an npx `mcpServers` entry.

**Files:**
- Modify: `packages/model/src/targets.ts` (add `"continue"` to `TargetId` + a `compose` registry entry), `packages/model/package.json` (add `yaml`)
- Test: `src/gem/__tests__/targets.continue.test.ts` + add `"continue"` to hardcoded target lists in `src/__tests__/schemas.test.ts` and `src/gem/__tests__/targets.test.ts`.

**Interfaces:**
- Consumes: `Gem`, `materialize`, `resolveArtifactRef` (existing in `@agentgem/model`).
- Produces: `TARGET_REGISTRY.continue` with a `compose` that emits `config.yaml`.

- [ ] **Step 1: Add the dep** — in `packages/model/package.json` `dependencies`, add `"yaml": "^2"`; `pnpm install`. Import in targets.ts: `import { stringify as stringifyYaml } from "yaml";`.

- [ ] **Step 2: Write the failing test**

```ts
// src/gem/__tests__/targets.continue.test.ts
import { describe, it, expect } from "vitest";
import { materialize } from "@agentgem/model";
import { parse as parseYaml } from "yaml";
import type { Gem } from "@agentgem/model";

const gem: Gem = { name: "my-gem", createdFrom: "t", checks: [], requiredSecrets: [], artifacts: [
  { type: "instructions", name: "style", content: "Prefer small diffs." },
  { type: "skill", name: "commit", source: "continue-prompt", content: "Write a commit for {{{ input }}}" },
  { type: "mcp_server", name: "local", transport: "stdio", config: { command: "node", args: ["s.js"] } },
  { type: "reference", name: "context7", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } },
] };

describe("continue target", () => {
  it("emits one config.yaml with rules, prompts, and mcpServers (ref as npx); nothing spuriously skipped", () => {
    const { files, skipped } = materialize(gem, "continue");
    expect(skipped).toEqual([]);   // no-op per-type renderers suppress the spurious "unsupported" skips
    const cfg = parseYaml(files["config.yaml"]);
    expect(cfg.name).toBe("my-gem");
    expect(cfg.version).toBeTruthy();
    expect(cfg.rules).toContainEqual({ name: "style", rule: "Prefer small diffs." });
    expect(cfg.prompts).toContainEqual({ name: "commit", prompt: "Write a commit for {{{ input }}}" });
    const byName = (n: string) => cfg.mcpServers.find((m: { name: string }) => m.name === n);
    expect(byName("local")).toMatchObject({ name: "local", command: "node", args: ["s.js"] });
    expect(byName("context7")).toMatchObject({ name: "context7", command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
```

- [ ] **Step 3: Implement the target** — in `packages/model/src/targets.ts`:
- Widen `TargetId`: add `| "continue"`.
- Add the compose renderer (near the other compose targets like flue/eve). Import `resolveArtifactRef` + `stringifyYaml` at the top.
```ts
const continueCompose = (gem: Gem): MaterializeResult => {
  const skipped: SkippedArtifact[] = [];
  const rules = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions").map((i) => ({ name: i.name, rule: i.content }));
  const prompts = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill").map((s) => ({ name: s.name, prompt: s.content, ...(s.description ? { description: s.description } : {}) }));
  const mcpServers: Record<string, unknown>[] = [];
  for (const a of gem.artifacts) {
    if (a.type === "mcp_server") mcpServers.push({ name: a.name, ...a.config });   // config already redacted
    else if (a.type === "reference" && a.refKind === "mcp_server") {
      const r = resolveArtifactRef(a);
      if (r.ok && r.artifact.type === "mcp_server") mcpServers.push({ name: a.name, ...r.artifact.config });
      else skipped.push({ artifact: a.name, type: "mcp_server", reason: r.ok ? "unsupported reference" : r.reason });
    }
  }
  const config: Record<string, unknown> = { name: gem.name, version: "0.0.1" };
  if (mcpServers.length) config.mcpServers = mcpServers;
  if (rules.length) config.rules = rules;
  if (prompts.length) config.prompts = prompts;
  return { files: { "config.yaml": stringifyYaml(config) }, skipped };
};
```
- Add to `TARGET_REGISTRY`. **Important — materialize semantics:** `materialize()` calls `skipAll(<type>)` for every artifact type whose per-type renderer is ABSENT, *then* runs `compose` last. So a compose-only target would still produce the correct `config.yaml` but would spuriously report every artifact in `skipped` as "unsupported on continue". To keep `skipped` honest, register **intentional no-op per-type renderers** (return an empty tree) so `skipAll` never fires; `compose` is the sole real renderer:
```ts
  continue: {
    id: "continue", label: "Continue",
    // Continue collapses every artifact into ONE config.yaml, emitted by compose below.
    // These per-type renderers are intentional no-ops: they exist only so materialize()
    // does not report artifacts as "unsupported on continue" via skipAll before compose runs.
    skill: () => ({}), instructions: () => ({}), mcp: () => rendered({}),
    compose: continueCompose,
  },
```
> With the no-op renderers returning empty trees, `merge` adds nothing and no skip fires; the package reference that `materialize` resolves into `resolvedMcpRefs` is passed to the no-op `mcp` renderer (discarded) and is independently handled by `continueCompose` (which re-resolves it). A `gem`-kind reference still surfaces its "not implemented" skip from `materialize`'s own resolution — correct. Net: for the happy path `skipped` is empty and `config.yaml` carries everything.

- [ ] **Step 4: Update hardcoded target lists + build + run**
- `src/__tests__/schemas.test.ts` (compatibility record) and `src/gem/__tests__/targets.test.ts` (sorted keys): insert `"continue"` alphabetically.

Add to the `targets.continue.test.ts` an assertion that `materialize(gem, "continue").skipped` is empty for this happy-path gem (proves the no-op renderers suppress the spurious skips).

Run: `pnpm build && pnpm test targets.continue targets schemas`
Expected: PASS, with `skipped` empty.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/targets.ts packages/model/package.json pnpm-lock.yaml src/gem/__tests__/targets.continue.test.ts src/__tests__/schemas.test.ts src/gem/__tests__/targets.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(model): continue materialize target (compose → config.yaml) + yaml dep

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Round-trip integration proof

**Files:**
- Test: `src/gem/__tests__/continue.roundtrip.test.ts`

**Interfaces:**
- Consumes: `readContinueArtifacts` (Task 2), `materialize` (Task 4), `writeGemArchive`/`readGemArchive` (`@agentgem/archive`).

- [ ] **Step 1: Write the round-trip test**

```ts
// src/gem/__tests__/continue.roundtrip.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContinueArtifacts } from "@agentgem/insight";
import { materialize } from "@agentgem/model";
import { parse as parseYaml } from "yaml";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

const yaml = `
name: src
version: 0.0.1
mcpServers:
  - name: context7
    command: npx
    args: ["-y", "@modelcontextprotocol/server-context7"]
rules:
  - name: style
    rule: "Prefer small diffs."
prompts:
  - name: commit
    prompt: "Commit for {{{ input }}}"
`;

describe("Continue round-trip: import -> Gem -> archive -> materialize back", () => {
  it("reproduces rules, prompts, and MCP (package ref as npx); binding dropped by the archive", async () => {
    const base = mkdtempSync(join(tmpdir(), "cont-rt-"));
    writeFileSync(join(base, "config.yaml"), yaml);
    const { artifacts, binding } = await readContinueArtifacts({ configFile: join(base, "config.yaml") });
    const gem: Gem = { name: "imported", createdFrom: "continue", artifacts, checks: [], requiredSecrets: [], bindings: [binding] };

    const back = readGemArchive(writeGemArchive(gem).files);
    expect(back.artifacts).toEqual(gem.artifacts);   // rules/prompts/refs survive the signed archive
    expect(back.bindings).toBeUndefined();

    const cfg = parseYaml(materialize(back, "continue").files["config.yaml"]);
    expect(cfg.rules).toContainEqual({ name: "style", rule: "Prefer small diffs." });
    expect(cfg.prompts).toContainEqual({ name: "commit", prompt: "Commit for {{{ input }}}" });
    expect(cfg.mcpServers.find((m: { name: string }) => m.name === "context7")).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
```

- [ ] **Step 2: Run it (should pass; if it fails, a real cross-task seam is broken — report, don't weaken)**

Run: `pnpm build && pnpm test continue.roundtrip`
Expected: PASS.

- [ ] **Step 3: Full suite**

Run (redirect, no tail): `pnpm test > /tmp/cont-suite.log 2>&1; echo $?` then read the summary. Only the known crypto flakes may fail — verify in isolation.

- [ ] **Step 4: Commit**

```bash
git add src/gem/__tests__/continue.roundtrip.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "test(insight): Continue import->gem->archive->materialize round-trip proof

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** session scan with the verified usage/timing mapping incl. the mtime end-proxy (Task 1); symmetric import of mcpServers(array)/rules/prompts with the `yaml` dep (Task 2); registration + id-list fallout (Task 3); compose target → single config.yaml resolving package refs, which also closes carried-finding #3 for this target (Task 4); round-trip proof (Task 5). Session-files usage source + symmetric scope per the decisions.
- **Type consistency:** `SessionStat` shape matches `observeAggregate.ts`; `ReferenceArtifact`/`McpServerArtifact`/`ImportResult`/`AgentBinding` per the packages; `firstPackage`/`isPublicNpm` reuse the shared util. `mcpServers` array-with-`name` handled on both import (read `srv.name`) and export (emit `{name, ...config}`).
- **Privacy:** neither `content` nor session `title` is ingested; only role (for counts), usage numbers, model title, workspaceDirectory.
- **Known deferrals:** `continueSource.readArtifacts` is the same registry stub as cline/gemini (per-repo config path wired later). The other Phase-3 minors (sse-transport labeling, etc.) remain out of scope.

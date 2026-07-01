# Multi-Agent Sources Implementation Plan (Phase 0–2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AgentGem ingest and materialize arbitrary coding agents behind one extensible abstraction, proven end-to-end with a Cline/Roo round-trip.

**Architecture:** Open the `Agent` closed union into a registry-derived `AgentId`; give the `Gem` an in-memory per-harness `bindings` overlay (unsigned) and a by-value/by-reference artifact discriminant (signed); introduce a `SourceSpec` inbound registry as an AgentBack `@extensionPoint` mirroring the existing `GEM_TYPES`, with the current claude/codex parsers refactored onto it; add a symmetric Cline `SourceSpec` + `TargetSpec`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), pnpm workspaces, Vitest, AgentBack DI (`@agentback/core`), `@agentgem/model` / `@agentgem/insight` / `@agentgem/archive`.

## Global Constraints

- **Privacy — metadata only.** Session scanning reads usage/timestamps/model/type/cwd/id ONLY, never message text.
- **Secrets never ingested.** MCP `env`/`headers` and any credential are redacted on import; a binding's `secretMap` holds env-var **names**, never values.
- **Total functions.** Missing dirs / malformed lines degrade to empty/skip, never throw. Absent agent install ⇒ `roots()` returns `[]` ⇒ the source contributes nothing.
- **Digest boundary.** The gem digest (via `@agentgem/archive` `computeLock`) signs the neutral core (manifest + artifact files, incl. a reference's `id`+`digest`). `bindings` are NOT serialized into the archive and MUST NOT change the digest.
- **Fixture-based tests.** None of the new agents is installed on dev machines and real-FS scans flake under concurrency — every new adapter test uses synthetic in-repo fixtures, never `~`.
- **Commits.** Author `Raymond Feng <raymond@ninemind.ai>`; trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly (Edits don't `git add`).
- **Test command.** Root `pnpm test` (Vitest). Per the repo, tests run from compiled `dist/` — rebuild or clean `dist/` after moving/renaming files.
- **TEST LOCATION (overrides every task's stated test path).** The root Vitest config only globs `dist/**/__tests__/**/*.test.js` — i.e. tests compiled from the **root `src/` tree**. Tests placed under `packages/*/src/__tests__/` compile to `packages/*/dist/` and are NEVER run by `pnpm test`. Therefore every new test in this plan MUST live at **`src/gem/__tests__/<name>.test.ts`** (matching the established siblings `src/gem/__tests__/canonicalize.test.ts`, `observeScan.test.ts`) and import the code under test from its published package (`@agentgem/model`, `@agentgem/insight`, `@agentgem/archive`), NOT via deep relative `../` paths into a package. Where a task's brief says `packages/*/src/__tests__/...`, read it as `src/gem/__tests__/...` with package imports.

---

## File Structure

- `packages/insight/src/observeAggregate.ts` — **modify**: `AgentId` type; widen `SessionStat.agent` + `ObservePayload` agent fields.
- `packages/model/src/canonicalize.ts` — **modify**: `canonicalHarness` accepts `AgentId`.
- `packages/model/src/types.ts` — **modify**: `ArtifactRef`, `ReferenceArtifact`, `AgentBinding`; add `ReferenceArtifact` to `GemArtifact`; add optional `Gem.bindings`.
- `packages/model/src/artifactRef.ts` — **create**: `resolveArtifactRef` seam (package → McpServer/Skill passthrough; gem → unresolved marker).
- `packages/archive/src/archive.ts` — **modify**: serialize/deserialize `ReferenceArtifact`.
- `packages/model/src/targets.ts` — **modify**: handle reference artifacts in `materialize`; add `cline` to `TargetId` + `TARGET_REGISTRY`.
- `packages/insight/src/sources.ts` — **create**: `SourceSpec`, `SourceEnv`, `BUILTIN_SOURCES` (claude, codex, cline), shared helpers.
- `packages/insight/src/sources/cline.ts` — **create**: Cline session scan + artifact read.
- `packages/insight/src/observeScan.ts` — **modify**: `scanSessions` becomes registry-driven.
- `src/gem/sourceRegistry.ts` — **create**: `AGENT_SOURCES` extension point (mirrors `gemTypeRegistry.ts`).
- `src/index.ts` — **modify**: `app.component(AgentSourcesComponent)`.

> **Placement note (refines the spec):** `SourceSpec` lives in `@agentgem/insight`, not `@agentgem/model`. Its methods touch the filesystem and return `SessionStat` (which lives in insight), so putting it in the pure/browser model package would invert the dependency. Only the DI wiring lives in the app layer, exactly as `GemTypeSpec` (pure, in model) vs `GemTypeRegistry` (DI, in app).

---

# PHASE 0 — Neutral spine

## Task 1: Open `AgentId`; widen the session types

**Files:**
- Modify: `packages/insight/src/observeAggregate.ts:10-35`
- Modify: `packages/insight/src/observeScan.ts:66,93` (parser return literals stay `"claude"`/`"codex"` — still valid)
- Modify: `packages/insight/src/inspectSession.ts:38,209`
- Modify: `packages/model/src/canonicalize.ts:53-55`
- Test: `packages/insight/src/__tests__/agentId.test.ts` (create)

**Interfaces:**
- Produces: `type AgentId = string` (exported from `observeAggregate.ts` and re-exported by `observeScan.ts`); `SessionStat.agent: AgentId`; `canonicalHarness(flavor: AgentId): Ingredient`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/insight/src/__tests__/agentId.test.ts
import { describe, it, expect } from "vitest";
import type { SessionStat, AgentId } from "../observeAggregate.js";
import { canonicalHarness } from "@agentgem/model";

describe("AgentId is open", () => {
  it("accepts a non-builtin agent on SessionStat", () => {
    const id: AgentId = "cline";
    const s: SessionStat = { agent: id, sessionId: "t", project: null, model: null, gitBranch: null, startMs: 0, endMs: 1, msgs: 1, tokensIn: 0, tokensOut: 0, tokensCache: 0 };
    expect(s.agent).toBe("cline");
  });
  it("canonicalHarness maps known ids and passes through new ones", () => {
    expect(canonicalHarness("claude")).toEqual({ id: "claude-code", idKind: "known", public: true });
    expect(canonicalHarness("codex")).toEqual({ id: "codex", idKind: "known", public: true });
    expect(canonicalHarness("cline")).toEqual({ id: "cline", idKind: "known", public: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/insight test agentId`
Expected: FAIL — `Type '"cline"' is not assignable to type '"claude" | "codex"'` and `canonicalHarness("cline")` returns `codex`.

- [ ] **Step 3: Widen the types**

In `packages/insight/src/observeAggregate.ts`, add above `SessionStat` and replace the agent fields:

```ts
/** Open, registry-derived agent identity. Runtime validity is the SourceRegistry's concern;
 *  the type stays `string` so the pure aggregation layer needs no registry dependency. */
export type AgentId = string;

export interface SessionStat {
  agent: AgentId;
  // …unchanged fields…
```

In the same file replace every `agent: "claude" | "codex"` inside `ObservePayload` (`sessions[]`, `models[]`) with `agent: AgentId`.

In `packages/insight/src/observeScan.ts` re-export it:
```ts
export type { SessionStat, ObserveRange, ObserveFilter, ObservePayload, AgentId } from "./observeAggregate.js";
```

In `packages/insight/src/inspectSession.ts` replace `agent: "claude" | "codex"` (lines 38, 209) with `agent: AgentId` and import the type.

In `packages/model/src/canonicalize.ts` replace `canonicalHarness`:
```ts
const KNOWN_HARNESS: Record<string, string> = { claude: "claude-code", codex: "codex" };
export function canonicalHarness(flavor: string): Ingredient {
  return { id: KNOWN_HARNESS[flavor] ?? flavor, idKind: "known", public: true };
}
```

- [ ] **Step 4: Run test + full suite to verify green**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/insight test agentId && pnpm test`
Expected: PASS; no regressions (existing observe/canonicalize tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/observeAggregate.ts packages/insight/src/observeScan.ts packages/insight/src/inspectSession.ts packages/model/src/canonicalize.ts packages/insight/src/__tests__/agentId.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): open Agent union into registry-derived AgentId

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 2: `AgentBinding` + optional `Gem.bindings` (digest-safe overlay)

**Files:**
- Modify: `packages/model/src/types.ts:144-151`
- Test: `packages/model/src/__tests__/bindings.test.ts` (create)

**Interfaces:**
- Produces: `interface AgentBinding { agent: string; origin: "imported" | "rendered"; model?: string; entry?: string; secretMap?: Record<string,string>; config?: Record<string, unknown> }`; `Gem.bindings?: AgentBinding[]`.

- [ ] **Step 1: Write the failing test** — proves bindings type-check AND do not change the digest.

```ts
// packages/model/src/__tests__/bindings.test.ts
import { describe, it, expect } from "vitest";
import type { Gem, AgentBinding } from "../types.js";
import { writeGemArchive } from "@agentgem/archive";

const base: Gem = { name: "g", createdFrom: "test", artifacts: [{ type: "instructions", name: "i", content: "hi" }], checks: [], requiredSecrets: [] };

describe("AgentBinding overlay", () => {
  it("is an optional unsigned overlay — never changes the gem digest", () => {
    const binding: AgentBinding = { agent: "cline", origin: "imported", model: "claude-sonnet-5" };
    const withB: Gem = { ...base, bindings: [binding] };
    const a = writeGemArchive(base);
    const b = writeGemArchive(withB);
    const digest = (files: Record<string, string>) => JSON.parse(files["gem.lock"]).gemDigest;
    expect(digest(b.files)).toBe(digest(a.files));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/model build && pnpm --filter @agentgem/model test bindings`
Expected: FAIL — `AgentBinding` and `Gem.bindings` do not exist (type error).

- [ ] **Step 3: Add the types**

In `packages/model/src/types.ts`, before `export interface Gem`:
```ts
// Per-harness execution overlay — delta-only (only what the neutral artifacts can't express).
// Unsigned: NOT serialized into the archive, so it never affects the gem digest.
export interface AgentBinding {
  agent: string;                      // AgentId this binding is for
  origin: "imported" | "rendered";    // mined FROM this harness, or exported TO it
  model?: string;
  entry?: string;
  secretMap?: Record<string, string>; // requiredSecret name -> this harness's env var NAME
  config?: Record<string, unknown>;
}
```
Add to `Gem`:
```ts
export interface Gem {
  // …existing fields…
  grade?: number;
  bindings?: AgentBinding[];  // in-memory overlay; absent = none. Not archived (see AgentBinding).
}
```

- [ ] **Step 4: Run test + suite**

Run: `pnpm --filter @agentgem/model build && pnpm --filter @agentgem/model test bindings && pnpm test`
Expected: PASS — digest identical because `writeGemArchive` never reads `gem.bindings`.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/types.ts packages/model/src/__tests__/bindings.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(model): add AgentBinding overlay to Gem (unsigned, digest-safe)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 3: By-reference artifacts (`ArtifactRef` + `ReferenceArtifact`)

**Files:**
- Modify: `packages/model/src/types.ts:4,58`
- Create: `packages/model/src/artifactRef.ts`
- Modify: `packages/model/src/index.ts` (export new module)
- Modify: `packages/archive/src/archive.ts:98-129,176-205` (write/read reference)
- Modify: `packages/model/src/targets.ts` (materialize handles references)
- Test: `packages/model/src/__tests__/artifactRef.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface ArtifactRef { kind: "package" | "gem"; id: string; digest?: string }`
  - `interface ReferenceArtifact { type: "reference"; name: string; refKind: ArtifactType; ref: ArtifactRef }`
  - `GemArtifact` union gains `ReferenceArtifact`
  - `resolveArtifactRef(a: ReferenceArtifact): { ok: true; artifact: GemArtifact } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/model/src/__tests__/artifactRef.test.ts
import { describe, it, expect } from "vitest";
import type { Gem, ReferenceArtifact } from "../types.js";
import { resolveArtifactRef } from "../artifactRef.js";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";

const pkgRef: ReferenceArtifact = { type: "reference", name: "ctx7", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } };

describe("by-reference artifacts", () => {
  it("round-trips through the archive and is covered by the digest", () => {
    const gem: Gem = { name: "g", createdFrom: "t", artifacts: [pkgRef], checks: [], requiredSecrets: [] };
    const { files } = writeGemArchive(gem);
    const back = readGemArchive(files);
    expect(back.artifacts[0]).toEqual(pkgRef);
  });
  it("digest changes if the pinned ref id changes (tamper-evident)", () => {
    const d = (r: ReferenceArtifact) => JSON.parse(writeGemArchive({ name: "g", createdFrom: "t", artifacts: [r], checks: [], requiredSecrets: [] }).files["gem.lock"]).gemDigest;
    expect(d(pkgRef)).not.toBe(d({ ...pkgRef, ref: { ...pkgRef.ref, id: "npx:@evil/pkg" } }));
  });
  it("resolves a package MCP reference into a runnable McpServerArtifact", () => {
    const r = resolveArtifactRef(pkgRef);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.artifact).toMatchObject({ type: "mcp_server", transport: "stdio" });
  });
  it("reports gem references as unresolved (resolution is a follow-on)", () => {
    const r = resolveArtifactRef({ type: "reference", name: "dep", refKind: "skill", ref: { kind: "gem", id: "sha256:abc" } });
    expect(r).toEqual({ ok: false, reason: "gem reference resolution is not implemented yet" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/model build && pnpm --filter @agentgem/model test artifactRef`
Expected: FAIL — types + `resolveArtifactRef` + archive handling missing.

- [ ] **Step 3: Add types**

In `packages/model/src/types.ts` after the `ChannelArtifact` block and before the `GemArtifact` union:
```ts
export interface ArtifactRef {
  kind: "package" | "gem";  // npx/npm package  |  registry gem digest
  id: string;               // e.g. "npx:@scope/pkg"  |  "sha256:<hex>"
  digest?: string;          // pinned in the lock at resolve time
}

// An artifact provided by reference rather than embedded bytes. `refKind` is what it stands
// in for. Discriminated by type:"reference" so existing type-narrowing on the 5 value kinds is unaffected.
export interface ReferenceArtifact {
  type: "reference";
  name: string;
  refKind: ArtifactType;
  ref: ArtifactRef;
}
```
Extend the union:
```ts
export type GemArtifact = SkillArtifact | McpServerArtifact | InstructionsArtifact | HookArtifact | ChannelArtifact | ReferenceArtifact;
```

- [ ] **Step 4: Create the resolver seam**

```ts
// packages/model/src/artifactRef.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import type { GemArtifact, McpServerArtifact, ReferenceArtifact } from "./types.js";

/** Resolve a by-reference artifact into a concrete one for materialization.
 *  package → reconstructed McpServerArtifact (stays a reference: an npx command, no bytes inlined).
 *  gem     → not yet resolved (registry fetch/merge is a follow-on); reported, never thrown. */
export function resolveArtifactRef(a: ReferenceArtifact):
  | { ok: true; artifact: GemArtifact }
  | { ok: false; reason: string } {
  if (a.ref.kind === "package") {
    // id shape "npx:@scope/pkg" or "runner:pkg" -> { command: runner, args: [pkg] }
    const [runner, ...rest] = a.ref.id.split(":");
    const pkg = rest.join(":");
    if (!runner || !pkg) return { ok: false, reason: `malformed package ref id '${a.ref.id}'` };
    const mcp: McpServerArtifact = { type: "mcp_server", name: a.name, transport: "stdio", config: { command: runner, args: [pkg] } };
    return { ok: true, artifact: mcp };
  }
  return { ok: false, reason: "gem reference resolution is not implemented yet" };
}
```
Export it from `packages/model/src/index.ts`:
```ts
export * from "./artifactRef.js";
```

- [ ] **Step 5: Serialize references in the archive**

In `packages/archive/src/archive.ts`, in the `for (const a of gem.artifacts)` loop, add a branch BEFORE the final `else` (hook) branch (guarding it so a reference is never misfiled as a hook):
```ts
    } else if (a.type === "reference") {
      const path = `refs/${withExt(seg, ".json")}`;
      const bodyStr = JSON.stringify({ refKind: a.refKind, ref: a.ref }, null, 2);
      if (place(path, bodyStr, a.name, "skill")) artifacts.push({ type: "reference", name: a.name, path } as ManifestArtifactEntry);
    } else {
```
In `readGemArchive`, add reconstruction before the final hook branch (line ~198):
```ts
    if (e.type === "reference") {
      const o = JSON.parse(body(e.path)) as { refKind: ReferenceArtifact["refKind"]; ref: ReferenceArtifact["ref"] };
      return { type: "reference", name: e.name, refKind: o.refKind, ref: o.ref };
    }
```
Import `ReferenceArtifact` in `archive.ts` and add `"reference"` to the `ManifestArtifactEntry.type` union where it is declared (search `ManifestArtifactEntry` in the archive package and widen its `type` field to include `"reference"`).

- [ ] **Step 6: Handle references in `materialize`**

In `packages/model/src/targets.ts` `materialize`, after the existing artifact filters, add:
```ts
  const refs = gem.artifacts.filter((a): a is ReferenceArtifact => a.type === "reference");
  for (const r of refs) {
    const res = resolveArtifactRef(r);
    if (!res.ok) { skipped.push({ artifact: r.name, type: r.refKind, reason: res.reason }); continue; }
    if (res.artifact.type === "mcp_server" && spec.mcp) {
      const out = spec.mcp([res.artifact]); merge(out.files, r.name, "mcp_server"); skipped.push(...out.skipped);
    } else {
      skipped.push({ artifact: r.name, type: r.refKind, reason: `reference of kind ${r.refKind} unsupported on ${target}` });
    }
  }
```
Add `ReferenceArtifact` + `resolveArtifactRef` to the imports at the top of `targets.ts`.

- [ ] **Step 7: Run test + suite**

Run: `pnpm --filter @agentgem/model build && pnpm --filter @agentgem/archive build && pnpm --filter @agentgem/model test artifactRef && pnpm test`
Expected: PASS. If any existing exhaustive `switch (a.type)` now errors on the new `"reference"` member, add a `case "reference":` that skips (those are compile-surfaced, fix each).

- [ ] **Step 8: Commit**

```bash
git add packages/model/src/types.ts packages/model/src/artifactRef.ts packages/model/src/index.ts packages/model/src/targets.ts packages/archive/src/archive.ts packages/model/src/__tests__/artifactRef.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(model): by-value/by-reference artifacts (package + gem), lock-pinned

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# PHASE 1 — The extension point

## Task 4: `SourceSpec` interface + built-in claude/codex specs

**Files:**
- Create: `packages/insight/src/sources.ts`
- Modify: `packages/insight/src/index.ts` (export sources)
- Test: `packages/insight/src/__tests__/sources.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface SourceEnv { baseDir?: string }`
  - `interface SourceSpec { id: AgentId; label: string; traits: { storage: "jsonl"|"json"|"sqlite"|"mixed" }; roots(env: SourceEnv): string[]; scanSessions?(roots: string[]): Promise<SessionStat[]>; readArtifacts?(roots: string[]): Promise<ImportResult> }`
  - `interface ImportResult { artifacts: GemArtifact[]; binding: AgentBinding }`
  - `const BUILTIN_SOURCES: SourceSpec[]` (claude, codex)

- [ ] **Step 1: Write the failing test**

```ts
// packages/insight/src/__tests__/sources.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SOURCES } from "../sources.js";

const claudeSpec = () => BUILTIN_SOURCES.find((s) => s.id === "claude")!;

describe("SourceSpec built-ins", () => {
  it("registers claude and codex", () => {
    expect(BUILTIN_SOURCES.map((s) => s.id).sort()).toEqual(["claude", "codex"]);
  });
  it("claude spec scans a fixture transcript into a SessionStat", async () => {
    const base = mkdtempSync(join(tmpdir(), "src-"));
    const proj = join(base, ".claude", "projects", "p"); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "11111111-1111-1111-1111-111111111111.jsonl"),
      JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00Z", cwd: "/x/demo", message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 5 } } }) + "\n");
    const spec = claudeSpec();
    const stats = await spec.scanSessions!(spec.roots({ baseDir: join(base, ".claude") }));
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ agent: "claude", project: "demo", model: "claude-sonnet-5", tokensIn: 10, tokensOut: 5 });
  });
  it("returns [] roots and never throws when the agent dir is absent", async () => {
    const spec = claudeSpec();
    const roots = spec.roots({ baseDir: "/no/such/dir/.claude" });
    await expect(spec.scanSessions!(roots)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/insight test sources`
Expected: FAIL — `../sources.js` does not exist.

- [ ] **Step 3: Implement `sources.ts` wrapping the existing parsers**

```ts
// packages/insight/src/sources.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The inbound SourceSpec registry: one entry per coding agent AgentGem can ingest. Mirrors the
// outbound TargetSpec. FS-touching + returns SessionStat, so it lives here (Node), not in the
// pure @agentgem/model. The DI extension point (SourceRegistry) is app-layer (see src/gem/sourceRegistry.ts).
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { resolveDirs } from "@agentgem/model";
import type { AgentBinding, GemArtifact } from "@agentgem/model";
import type { AgentId, SessionStat } from "./observeAggregate.js";
import { listFiles, parseClaudeTranscript, parseCodexTranscript } from "./observeScan.js";

export interface SourceEnv { baseDir?: string }
export interface ImportResult { artifacts: GemArtifact[]; binding: AgentBinding }

export interface SourceSpec {
  id: AgentId;
  label: string;
  traits: { storage: "jsonl" | "json" | "sqlite" | "mixed" };
  roots(env: SourceEnv): string[];                        // may be empty when the agent is absent
  scanSessions?(roots: string[]): Promise<SessionStat[]>; // capability: telemetry
  readArtifacts?(roots: string[]): Promise<ImportResult>; // capability: authoring
}

async function scanJsonl(files: string[], parse: (t: string, p: string) => SessionStat | null): Promise<SessionStat[]> {
  const out: SessionStat[] = [];
  for (const f of files) {
    let text: string; try { text = await readFile(f, "utf8"); } catch { continue; }
    const s = parse(text, f); if (s) out.push(s);
  }
  return out;
}

const claudeSource: SourceSpec = {
  id: "claude", label: "Claude Code", traits: { storage: "jsonl" },
  roots: (env) => [join(resolveDirs(env.baseDir).claudeDir, "projects")],
  scanSessions: (roots) => scanJsonl(roots.flatMap((r) => listFiles(r, ".jsonl")), parseClaudeTranscript),
};

const codexSource: SourceSpec = {
  id: "codex", label: "Codex", traits: { storage: "jsonl" },
  roots: (env) => [join(resolveDirs(env.baseDir).codexDir, "sessions")],
  scanSessions: (roots) =>
    scanJsonl(roots.flatMap((r) => listFiles(r, ".jsonl")).filter((f) => basename(f).startsWith("rollout-")), parseCodexTranscript),
};

export const BUILTIN_SOURCES: SourceSpec[] = [claudeSource, codexSource];
```
> Note: `resolveDirs(baseDir)` treats `baseDir` as the `.claude` dir and derives `.codex` from its parent (see `resolveDir.ts`); the fixture places both under one temp parent, matching production.

Export from `packages/insight/src/index.ts`:
```ts
export * from "./sources.js";
```

- [ ] **Step 4: Run test + suite**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/insight test sources && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sources.ts packages/insight/src/index.ts packages/insight/src/__tests__/sources.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): SourceSpec inbound registry with claude/codex built-ins

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 5: Make `scanSessions` registry-driven

**Files:**
- Modify: `packages/insight/src/observeScan.ts:111-126`
- Test: `packages/insight/src/__tests__/scanRegistry.test.ts` (create)

**Interfaces:**
- Consumes: `BUILTIN_SOURCES`, `SourceSpec`, `SourceEnv` (Task 4).
- Produces: `scanSessions(dirs?, specs?: SourceSpec[]): Promise<SessionStat[]>` — same default behavior; `specs` defaults to `BUILTIN_SOURCES`.

- [ ] **Step 1: Write the failing test** — a custom one-off spec is honored, and defaults are unchanged.

```ts
// packages/insight/src/__tests__/scanRegistry.test.ts
import { describe, it, expect } from "vitest";
import { scanSessions } from "../observeScan.js";
import type { SourceSpec } from "../sources.js";

describe("registry-driven scanSessions", () => {
  it("folds in a custom spec's sessions", async () => {
    const fake: SourceSpec = { id: "fake", label: "F", traits: { storage: "json" }, roots: () => ["r"],
      scanSessions: async () => [{ agent: "fake", sessionId: "s", project: null, model: null, gitBranch: null, startMs: 0, endMs: 1, msgs: 1, tokensIn: 1, tokensOut: 1, tokensCache: 0 }] };
    const stats = await scanSessions(undefined, [fake]);
    expect(stats.map((s) => s.agent)).toEqual(["fake"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/insight test scanRegistry`
Expected: FAIL — `scanSessions` doesn't accept a second arg.

- [ ] **Step 3: Rewrite `scanSessions`**

Replace the body of `scanSessions` (`observeScan.ts:111-126`) with:
```ts
import { BUILTIN_SOURCES, type SourceSpec } from "./sources.js"; // add to imports at top of file

export async function scanSessions(dirs?: { claudeDir?: string; codexDir?: string }, specs: SourceSpec[] = BUILTIN_SOURCES): Promise<SessionStat[]> {
  // Preserve the legacy per-agent override: dirs.claudeDir feeds baseDir; codexDir derives from its parent.
  const env = { baseDir: dirs?.claudeDir };
  const out: SessionStat[] = [];
  for (const spec of specs) {
    if (!spec.scanSessions) continue;
    try { out.push(...(await spec.scanSessions(spec.roots(env)))); } catch { /* a source never breaks the scan */ }
  }
  return out;
}
```
> The `codexDir` override is dropped from the fast path; production and the observe tests only override the base (`.claude`) dir, from which codex derives. If a test overrides `codexDir` independently, keep it working by leaving `parseCodexTranscript` reachable — verify in Step 4.

- [ ] **Step 4: Run the full observe suite + new test**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/insight test && pnpm test`
Expected: PASS. If any observe test overrode `codexDir` explicitly and now fails, extend `SourceEnv` with an optional `codexDir` and thread it through `codexSource.roots`; re-run.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/observeScan.ts packages/insight/src/__tests__/scanRegistry.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "refactor(insight): scanSessions folds over the SourceSpec registry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 6: `AGENT_SOURCES` DI extension point

**Files:**
- Create: `src/gem/sourceRegistry.ts` (mirror `src/gem/gemTypeRegistry.ts`)
- Modify: `src/index.ts:19,71` (import + `app.component`)
- Test: `src/gem/__tests__/sourceRegistry.test.ts` (create)

**Interfaces:**
- Produces: `const AGENT_SOURCES = "agentgem.agentSources"`; `class SourceRegistry { all(): SourceSpec[]; byId(id): SourceSpec | undefined }`; `class AgentSourcesComponent`; `const defaultSourceRegistry`.

- [ ] **Step 1: Write the failing test** (mirrors `gemTypeRegistry.test.ts` plugin pattern)

```ts
// src/gem/__tests__/sourceRegistry.test.ts
import { describe, it, expect } from "vitest";
import { Binding, extensionFor } from "@agentback/core";
import { RestApplication } from "@agentback/rest";
import { AGENT_SOURCES, AgentSourcesComponent, SourceRegistry, defaultSourceRegistry } from "../sourceRegistry.js";
import type { SourceSpec } from "@agentgem/insight";

describe("AGENT_SOURCES extension point", () => {
  it("default registry exposes the built-ins", () => {
    expect(defaultSourceRegistry.byId("claude")?.id).toBe("claude");
  });
  it("a plugin can contribute a source via extensionFor(AGENT_SOURCES)", async () => {
    // Mirror the app setup + container-resolution EXACTLY from the sibling test
    // src/gem/__tests__/gemTypeRegistry.test.ts (GemTypesComponent + GemTypeRegistry).
    // Read that file first and copy its RestApplication construction and `app.get(...)` key verbatim,
    // substituting AgentSourcesComponent / SourceRegistry.
    const app = /* same construction as gemTypeRegistry.test.ts */ null as any;
    app.component(AgentSourcesComponent);
    const plugin: SourceSpec = { id: "cursor", label: "Cursor", traits: { storage: "sqlite" }, roots: () => [] };
    app.add(Binding.bind("agentSources.cursor").to(plugin).apply(extensionFor(AGENT_SOURCES)));
    const reg = await app.get<SourceRegistry>(/* same key as gemTypeRegistry.test.ts */);
    expect(reg.byId("cursor")?.label).toBe("Cursor");
  });
});
```
> The DI resolution key/API is repo-specific; `src/gem/__tests__/gemTypeRegistry.test.ts` is the authoritative, already-passing example — read it and match its construction exactly. The `defaultSourceRegistry` assertion above needs no container and can stand alone if the DI harness proves fiddly.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && pnpm vitest run src/gem/__tests__/sourceRegistry.test.ts`
Expected: FAIL — `../sourceRegistry.js` missing.

- [ ] **Step 3: Implement `sourceRegistry.ts`** (carbon copy of `gemTypeRegistry.ts`)

```ts
// src/gem/sourceRegistry.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The AGENT_SOURCES DI extension point: the inbound agent vocabulary (built-ins + plugin-
// contributed sources) resolved through the container. Mirrors GEM_TYPES exactly. The pure
// SourceSpec + built-ins live in @agentgem/insight; this is the DI wiring.
import { extensionPoint, extensions, extensionFor, Binding, type Component } from "@agentback/core";
import { BUILTIN_SOURCES, type SourceSpec } from "@agentgem/insight";

export const AGENT_SOURCES = "agentgem.agentSources";

@extensionPoint(AGENT_SOURCES)
export class SourceRegistry {
  constructor(@extensions.list(AGENT_SOURCES) private specs: SourceSpec[]) {}
  all(): SourceSpec[] { return [...this.specs]; }
  byId(id: string): SourceSpec | undefined { return this.specs.find((s) => s.id === id); }
}

export class AgentSourcesComponent implements Component {
  bindings = BUILTIN_SOURCES.map((spec) =>
    Binding.bind(`agentSources.${spec.id}`).to(spec).apply(extensionFor(AGENT_SOURCES)));
  services = [SourceRegistry];
}

export const defaultSourceRegistry = new SourceRegistry(BUILTIN_SOURCES);
```

Wire into `src/index.ts` (mirroring line 19 + 71):
```ts
import { AgentSourcesComponent } from "./gem/sourceRegistry.js";
// …in the app setup, next to app.component(GemTypesComponent):
app.component(AgentSourcesComponent);
```

- [ ] **Step 4: Run test + suite**

Run: `pnpm build && pnpm vitest run src/gem/__tests__/sourceRegistry.test.ts && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/sourceRegistry.ts src/index.ts src/gem/__tests__/sourceRegistry.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(app): AGENT_SOURCES AgentBack extension point (mirrors GEM_TYPES)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# PHASE 2 — Cline/Roo round-trip (the proof)

Fixtures live in `packages/insight/src/__tests__/fixtures/cline/` and model a globalStorage layout:
`tasks/<taskId>/ui_messages.json`, `tasks/<taskId>/api_conversation_history.json`, `settings/cline_mcp_settings.json`, plus a repo `.clinerules`.

## Task 7: Cline session scan → `SessionStat`

**Files:**
- Create: `packages/insight/src/sources/cline.ts`
- Test: `packages/insight/src/__tests__/cline.scan.test.ts` (create) + fixtures

**Interfaces:**
- Produces: `parseClineTask(uiMessagesJson: string, taskId: string): SessionStat | null` and `scanClineSessions(taskDirs: string[]): Promise<SessionStat[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/insight/src/__tests__/cline.scan.test.ts
import { describe, it, expect } from "vitest";
import { parseClineTask } from "../sources/cline.js";

// ui_messages.json: array of ClineMessage; usage lives in say:"api_req_started" whose .text is JSON-stringified.
const ui = JSON.stringify([
  { ts: 1751328000000, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 100, tokensOut: 40, cacheReads: 10, cacheWrites: 5, cost: 0.01 }) },
  { ts: 1751328000000, type: "say", say: "text", text: "hello" },
  { ts: 1751328600000, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 50, tokensOut: 20 }) },
]);

describe("Cline task parsing", () => {
  it("sums api_req_started token fields and derives timing", () => {
    const s = parseClineTask(ui, "1751328000000")!;
    expect(s).toMatchObject({ agent: "cline", sessionId: "1751328000000", tokensIn: 150, tokensOut: 60, tokensCache: 15 });
    expect(s.startMs).toBe(1751328000000);
    expect(s.endMs).toBe(1751328600000);
  });
  it("returns null for an empty/malformed task", () => {
    expect(parseClineTask("not json", "x")).toBeNull();
    expect(parseClineTask("[]", "x")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/insight test cline.scan`
Expected: FAIL — `../sources/cline.js` missing.

- [ ] **Step 3: Implement the Cline parser**

```ts
// packages/insight/src/sources/cline.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Cline / Roo task ingestion. Clean flat JSON (contrast Cursor's SQLite): each task dir holds
// ui_messages.json (UI timeline). Usage lives in say:"api_req_started" whose .text is a
// JSON-STRINGIFIED ClineApiReqInfo (parse twice). Metadata only — never message text.
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { SessionStat } from "../observeAggregate.js";

interface ClineMsg { ts?: number; type?: string; say?: string; text?: string }

export function parseClineTask(uiMessagesJson: string, taskId: string): SessionStat | null {
  let msgs: ClineMsg[];
  try { msgs = JSON.parse(uiMessagesJson) as ClineMsg[]; } catch { return null; }
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  let startMs = Infinity, endMs = -Infinity, count = 0, tokensIn = 0, tokensOut = 0, tokensCache = 0;
  for (const m of msgs) {
    if (typeof m.ts === "number") { startMs = Math.min(startMs, m.ts); endMs = Math.max(endMs, m.ts); }
    if (m.type === "say" && m.say === "text") count++;
    if (m.say === "api_req_started" && typeof m.text === "string") {
      try {
        const info = JSON.parse(m.text) as Record<string, number>;
        tokensIn += info.tokensIn ?? 0;
        tokensOut += info.tokensOut ?? 0;
        tokensCache += (info.cacheReads ?? 0) + (info.cacheWrites ?? 0);
      } catch { /* skip malformed api_req_started */ }
    }
  }
  if (endMs < startMs) return null;
  return { agent: "cline", sessionId: taskId, project: null, model: null, gitBranch: null, startMs, endMs, msgs: count, tokensIn, tokensOut, tokensCache };
}

export async function scanClineSessions(taskDirs: string[]): Promise<SessionStat[]> {
  const out: SessionStat[] = [];
  for (const dir of taskDirs) {
    let text: string; try { text = await readFile(join(dir, "ui_messages.json"), "utf8"); } catch { continue; }
    const s = parseClineTask(text, basename(dir)); if (s) out.push(s);
  }
  return out;
}
```

- [ ] **Step 4: Run test + suite**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/insight test cline.scan && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sources/cline.ts packages/insight/src/__tests__/cline.scan.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): Cline/Roo session scan (api_req_started token sums)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 8: Cline artifact read + imported binding

**Files:**
- Modify: `packages/insight/src/sources/cline.ts`
- Test: `packages/insight/src/__tests__/cline.artifacts.test.ts` (create)

**Interfaces:**
- Consumes: `ImportResult`, `ArtifactRef`/`ReferenceArtifact` (Tasks 3–4), `canonicalMcpServer`-style public-package detection isn't required here (we emit a `package` ref only for public npx packages).
- Produces: `readClineArtifacts(env: { rulesFile?: string; mcpSettingsFile?: string }): Promise<ImportResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/insight/src/__tests__/cline.artifacts.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClineArtifacts } from "../sources/cline.js";

describe("Cline artifact import", () => {
  it("imports .clinerules as instructions and MCP servers, with a public npx server as a package reference", async () => {
    const base = mkdtempSync(join(tmpdir(), "cline-"));
    writeFileSync(join(base, ".clinerules"), "Always write tests first.");
    const settings = join(base, "settings"); mkdirSync(settings);
    writeFileSync(join(settings, "cline_mcp_settings.json"), JSON.stringify({ mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
      local: { command: "node", args: ["./my-server.js"], env: { TOKEN: "secret" } },
    } }));
    const { artifacts, binding } = await readClineArtifacts({ rulesFile: join(base, ".clinerules"), mcpSettingsFile: join(settings, "cline_mcp_settings.json") });
    const instr = artifacts.find((a) => a.type === "instructions");
    expect(instr).toMatchObject({ type: "instructions", content: "Always write tests first." });
    const ref = artifacts.find((a) => a.type === "reference");
    expect(ref).toMatchObject({ type: "reference", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } });
    const local = artifacts.find((a) => a.type === "mcp_server");
    expect(local).toMatchObject({ type: "mcp_server", name: "local" });
    expect(JSON.stringify(local)).not.toContain("secret"); // env redacted
    expect(binding).toMatchObject({ agent: "cline", origin: "imported" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/insight test cline.artifacts`
Expected: FAIL — `readClineArtifacts` missing.

- [ ] **Step 3: Implement `readClineArtifacts`**

```ts
// append to packages/insight/src/sources/cline.ts
import type { GemArtifact, McpServerArtifact, ReferenceArtifact } from "@agentgem/model";
import type { ImportResult } from "../sources.js";

const PUBLIC_SCOPES = new Set(["@modelcontextprotocol"]);
// First non-flag arg is the package spec.
function firstPackage(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  for (const a of args) { if (typeof a === "string" && !a.startsWith("-")) return a; }
  return null;
}
function isPublicNpm(pkg: string): boolean {
  if (pkg.startsWith("/") || pkg.startsWith(".")) return false;
  if (pkg.startsWith("@")) return PUBLIC_SCOPES.has(pkg.split("/")[0]);
  return /^[a-z0-9][a-z0-9._-]*$/i.test(pkg);
}

export async function readClineArtifacts(env: { rulesFile?: string; mcpSettingsFile?: string }): Promise<ImportResult> {
  const artifacts: GemArtifact[] = [];
  if (env.rulesFile) {
    try {
      const content = await readFile(env.rulesFile, "utf8");
      if (content.trim()) artifacts.push({ type: "instructions", name: "clinerules", content });
    } catch { /* absent */ }
  }
  if (env.mcpSettingsFile) {
    try {
      const raw = JSON.parse(await readFile(env.mcpSettingsFile, "utf8")) as { mcpServers?: Record<string, { command?: string; args?: unknown; env?: Record<string, unknown>; url?: string }> };
      for (const [name, cfg] of Object.entries(raw.mcpServers ?? {})) {
        const pkg = firstPackage(cfg.args);
        if (cfg.command === "npx" && pkg && isPublicNpm(pkg)) {
          const ref: ReferenceArtifact = { type: "reference", name, refKind: "mcp_server", ref: { kind: "package", id: `npx:${pkg}` } };
          artifacts.push(ref);
        } else {
          // Redact secret-bearing env; keep only command/args (metadata only).
          const server: McpServerArtifact = { type: "mcp_server", name, transport: cfg.url ? "http" : "stdio", config: cfg.url ? { url: cfg.url } : { command: cfg.command, args: cfg.args } };
          artifacts.push(server);
        }
      }
    } catch { /* absent/malformed */ }
  }
  return { artifacts, binding: { agent: "cline", origin: "imported" } };
}
```

- [ ] **Step 4: Run test + suite**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/insight test cline.artifacts && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sources/cline.ts packages/insight/src/__tests__/cline.artifacts.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): Cline artifact import (rules + MCP, public npx as package ref)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 9: Register the `cline` SourceSpec

**Files:**
- Modify: `packages/insight/src/sources.ts` (add `clineSource` to `BUILTIN_SOURCES`)
- Test: `packages/insight/src/__tests__/cline.source.test.ts` (create)

**Interfaces:**
- Consumes: `scanClineSessions`, `readClineArtifacts` (Tasks 7–8).
- Produces: `clineSource: SourceSpec` with `id:"cline"`, `traits.storage:"json"`, discovering `tasks/*/` under VS Code globalStorage roots.

- [ ] **Step 1: Write the failing test**

```ts
// packages/insight/src/__tests__/cline.source.test.ts
import { describe, it, expect } from "vitest";
import { BUILTIN_SOURCES } from "../sources.js";

describe("cline SourceSpec", () => {
  it("is registered with json storage and both faces", () => {
    const cline = BUILTIN_SOURCES.find((s) => s.id === "cline");
    expect(cline?.traits.storage).toBe("json");
    expect(typeof cline?.scanSessions).toBe("function");
    expect(typeof cline?.readArtifacts).toBe("function");
  });
  it("returns [] roots when no globalStorage exists (never throws)", async () => {
    const cline = BUILTIN_SOURCES.find((s) => s.id === "cline")!;
    await expect(cline.scanSessions!(cline.roots({ baseDir: "/no/such" }))).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/insight test cline.source`
Expected: FAIL — no `cline` in `BUILTIN_SOURCES`.

- [ ] **Step 3: Add `clineSource`**

In `packages/insight/src/sources.ts`:
```ts
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { scanClineSessions, readClineArtifacts } from "./sources/cline.js";

// macOS globalStorage roots for VS Code + forks that host the Cline extension. baseDir overrides for tests.
function clineTaskDirs(baseDir?: string): string[] {
  const roots = baseDir ? [baseDir] : ["Code", "Code - Insiders", "Cursor", "VSCodium", "Windsurf"].map(
    (app) => join(homedir(), "Library", "Application Support", app, "User", "globalStorage", "saoudrizwan.claude-dev", "tasks"));
  const dirs: string[] = [];
  const seen = new Set<string>();               // dedup by taskId across editor forks
  for (const root of roots) {
    let entries: import("node:fs").Dirent[]; try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isDirectory() && !seen.has(e.name)) { seen.add(e.name); dirs.push(join(root, e.name)); }
  }
  return dirs;
}

const clineSource: SourceSpec = {
  id: "cline", label: "Cline / Roo", traits: { storage: "json" },
  roots: (env) => clineTaskDirs(env.baseDir),
  scanSessions: (roots) => scanClineSessions(roots),
  readArtifacts: async (roots) => readClineArtifacts({}), // per-repo rules/mcp paths are supplied by the caller in Phase 3; roots here are task dirs
};
```
Add `clineSource` to the `BUILTIN_SOURCES` array.
> `roots()` returns task dirs for the sessions face; the artifact face's rule/mcp file locations are per-repo and passed explicitly by callers (as the tests do). Unifying both into one `env` shape is a Phase 3 cleanup when the second adapter lands.

- [ ] **Step 4: Run test + suite**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/insight test cline && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/sources.ts packages/insight/src/__tests__/cline.source.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): register cline SourceSpec (globalStorage discovery + dedup)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 10: Cline `TargetSpec` (materialize a Gem into Cline's layout)

**Files:**
- Modify: `packages/model/src/targets.ts:16` (add `"cline"` to `TargetId`), `:855` (registry entry), plus two renderers.
- Modify: `src/schemas.ts` if `TargetIdSchema` is a hardcoded enum (it derives from `TARGET_REGISTRY` keys — verify at line ~227; if derived, no change needed).
- Test: `packages/model/src/__tests__/targets.cline.test.ts` (create)

**Interfaces:**
- Consumes: `Gem`, `materialize` (existing).
- Produces: `TARGET_REGISTRY.cline` with `instructions` → `.clinerules`, `mcp` → `cline_mcp_settings.json`, `skill` → `.clinerules/skills/<name>/SKILL.md`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/model/src/__tests__/targets.cline.test.ts
import { describe, it, expect } from "vitest";
import { materialize } from "../targets.js";
import type { Gem } from "../types.js";

const gem: Gem = { name: "g", createdFrom: "t", checks: [], requiredSecrets: [], artifacts: [
  { type: "instructions", name: "rules", content: "Test first." },
  { type: "mcp_server", name: "local", transport: "stdio", config: { command: "node", args: ["s.js"] } },
  { type: "reference", name: "context7", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } },
] };

describe("cline target", () => {
  it("writes .clinerules and cline_mcp_settings.json, keeping the package ref as an npx command", () => {
    const { files } = materialize(gem, "cline");
    expect(files[".clinerules"]).toBe("Test first.");
    const mcp = JSON.parse(files["cline_mcp_settings.json"]);
    expect(mcp.mcpServers.local).toMatchObject({ command: "node", args: ["s.js"] });
    expect(mcp.mcpServers.context7).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/model build && pnpm --filter @agentgem/model test targets.cline`
Expected: FAIL — `"cline"` not a `TargetId`.

- [ ] **Step 3: Implement the target**

In `packages/model/src/targets.ts`:
- Widen `TargetId`: add `| "cline"`.
- Add renderers near the other target renderers:
```ts
const instructionsClinerules = (all: InstructionsArtifact[]): FileTree => ({ ".clinerules": all.map((i) => i.content).join("\n\n") });
const skillClinerules = (a: SkillArtifact): FileTree => ({ [`.clinerules/skills/${safePathSegment(a.name)}/SKILL.md`]: a.content });
const mcpClineSettings = (servers: McpServerArtifact[]): MaterializeResult => {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) mcpServers[s.name] = s.config;   // config already redacted at import
  return rendered({ "cline_mcp_settings.json": JSON.stringify({ mcpServers }, null, 2) });
};
```
- Add to `TARGET_REGISTRY`:
```ts
  cline: { id: "cline", label: "Cline / Roo", skill: skillClinerules, instructions: instructionsClinerules, mcp: mcpClineSettings },
```
> The package reference reaches `mcp` via the reference-handling block added in Task 3 Step 6 (it calls `spec.mcp([resolvedMcp])`), so `context7` renders as an `npx` command — verify in Step 4.

- [ ] **Step 4: Run test + suite**

Run: `pnpm --filter @agentgem/model build && pnpm --filter @agentgem/model test targets.cline && pnpm test`
Expected: PASS. If `src/schemas.ts` `TargetIdSchema` is a hand-written enum rather than derived from `TARGET_REGISTRY`, add `"cline"` there and re-run.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/targets.ts packages/model/src/__tests__/targets.cline.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(model): cline materialize target (.clinerules + cline_mcp_settings.json)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 11: Round-trip integration test (the proof)

**Files:**
- Test: `packages/insight/src/__tests__/cline.roundtrip.test.ts` (create)

**Interfaces:**
- Consumes: `readClineArtifacts` (Task 8), `materialize` (Task 10), `writeGemArchive`/`readGemArchive` (Task 3).

- [ ] **Step 1: Write the round-trip test**

```ts
// packages/insight/src/__tests__/cline.roundtrip.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClineArtifacts } from "../sources/cline.js";
import { materialize } from "@agentgem/model";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

describe("Cline round-trip: import -> Gem -> archive -> materialize back", () => {
  it("reproduces rules + MCP, survives the archive, keeps the package ref as npx", async () => {
    const base = mkdtempSync(join(tmpdir(), "rt-"));
    writeFileSync(join(base, ".clinerules"), "Prefer small diffs.");
    const settings = join(base, "settings"); mkdirSync(settings);
    writeFileSync(join(settings, "cline_mcp_settings.json"), JSON.stringify({ mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
    } }));

    const { artifacts, binding } = await readClineArtifacts({ rulesFile: join(base, ".clinerules"), mcpSettingsFile: join(settings, "cline_mcp_settings.json") });
    const gem: Gem = { name: "imported", createdFrom: "cline", artifacts, checks: [], requiredSecrets: [], bindings: [binding] };

    // survives the signed archive
    const back = readGemArchive(writeGemArchive(gem).files);
    expect(back.artifacts).toEqual(gem.artifacts);

    // materializes back into Cline's native layout
    const { files } = materialize(back, "cline");
    expect(files[".clinerules"]).toBe("Prefer small diffs.");
    expect(JSON.parse(files["cline_mcp_settings.json"]).mcpServers.context7).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
    // binding is an in-memory overlay: present on the gem, absent from the archive
    expect(back.bindings).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `pnpm build && pnpm --filter @agentgem/insight test cline.roundtrip`
Expected: PASS (all prerequisites are implemented in Tasks 3–10). If it fails, the failure pinpoints the broken seam — fix that task, not this test.

- [ ] **Step 3: Run the full suite**

Run: `pnpm test`
Expected: PASS — no regressions across the repo.

- [ ] **Step 4: Commit**

```bash
git add packages/insight/src/__tests__/cline.roundtrip.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "test(insight): Cline import->gem->archive->materialize round-trip proof

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Follow-ons (Phase 3 — out of scope here)

Each is an isolated `SourceSpec` + `TargetSpec` plug-in, no core changes: **Gemini CLI** (JSONL sessions with `$rewindTo`/`$set` mutation folding, `GEMINI.md`, `commands/*.toml`), **Continue** (`sessions/*.json` + `dev_data/*/tokensGenerated.jsonl`, `config.yaml`), **Cursor** (SQLite `state.vscdb` — copy-before-read, double-encoded JSON, multi-DB union). Also deferred: **gem-reference resolution** (registry fetch/merge for `kind:"gem"`), and **persisting bindings** as an unsigned side-file in the archive (needs a `computeLock` change to exclude a path from the hashed set).

## Self-review notes

- **Spec coverage:** AgentId (Task 1), bindings delta-only/unsigned (Task 2), by-value/reference package+gem (Task 3), SourceSpec + registry-driven scan (Tasks 4–5), AGENT_SOURCES extension point mirroring GEM_TYPES (Task 6), symmetric Cline source+target round-trip (Tasks 7–11), privacy/metadata-only + secret redaction + never-throw (Tasks 7–9), fixture-based tests (all Phase 2). Digest boundary verified by construction (Tasks 2–3). Gem-ref *resolution* and binding *persistence* are explicitly deferred with reasons.
- **Type consistency:** `SessionStat.agent: AgentId` (string) used consistently; `ReferenceArtifact.type:"reference"` + `refKind` keeps the 5 value kinds' narrowing intact; `ImportResult` shape identical across Tasks 4/8/9; `resolveArtifactRef` return shape identical across Tasks 3/target-handling.

# Multi-Agent Sources: Extensible Ingestion + Symmetric Materialization

**Date:** 2026-07-01
**Status:** Design — ready for implementation planning
**Companion:** `2026-07-01-agent-artifact-inventory.md` (the grounding research)

## Summary

AgentGem ingests coding-agent artifacts today, but is effectively hardcoded to two agents (Claude Code, Codex) via a closed `Agent` union and two bespoke transcript parsers. This design broadens the input surface to arbitrary coding/co-working agents behind **one abstraction**, using the same AgentBack extension-point pattern that already powers `GEM_TYPES`. It makes the abstraction **symmetric** — each agent can be both an ingest **source** and a materialize **target** (round-trip) — and refines the Gem model with **per-harness bindings** and **by-value / by-reference artifacts**.

First delivery (Phase 0–2) proves the whole thing end-to-end on **Cline/Roo**; Gemini CLI, Continue, and Cursor follow as pure plug-ins (Phase 3).

## Goals

- One neutral abstraction over "an agent's artifacts" spanning **both** streams: setup artifacts (skill / mcp_server / instructions / hook) **and** sessions/usage telemetry.
- New agents plug in as **bindings on an extension point**, never a fork of the scan pipeline.
- **Symmetric**: reuse the same `AgentId` for inbound `SourceSpec` and outbound `TargetSpec`, enabling import → Gem → materialize-back round-trips.
- Preserve existing invariants: metadata-only telemetry (no message text), signed-digest integrity, browser-safe aggregation.

## Non-goals

- Reading message content for telemetry (unchanged privacy boundary).
- Implementing all four new adapters now (only Cline/Roo in this pass).
- A new fetch/resolution stack — by-reference artifacts reuse the existing lock + SSRF-guarded/registry path.
- `url` / `skill` reference kinds (follow-on; this pass ships `package` + `gem`).

## Current state (what we build on)

- **Ingestion** — `packages/insight/src/observeScan.ts`: `scanSessions()` hardcodes `parseClaudeTranscript` + `parseCodexTranscript`; `Agent = "claude" | "codex"`; paths from `packages/model/src/resolveDir.ts` (`resolveDirs()` → fixed `{claudeDir, agentDir, codexDir, hermesDir}`). Aggregation (`observeAggregate.ts`) is pure/browser-safe over `SessionStat`.
- **Extension pattern** — `GEM_TYPES` is a real AgentBack `@extensionPoint`: pure `GemTypeSpec` in `@agentgem/model`, DI `GemTypeRegistry` (`@extensions.list(GEM_TYPES)`), `GemTypesComponent` binds `BUILTIN_CUTS` with `extensionFor(GEM_TYPES)`, wired via `app.component(...)`. **This design mirrors it exactly for sources.**
- **Materialization** — `packages/model/src/targets.ts`: `TargetSpec` + static `TARGET_REGISTRY` keyed by `TargetId`; pure `materialize(gem, target)`.
- **Gem model** — neutral `artifacts[]` (skill/mcp_server/instructions/hook/channel) + `checks`, `requiredSecrets`, `grade`; digest signs the artifact set.

---

## Design

### 1. Neutral spine

**`AgentId` — open, registry-derived.** Replace the closed union `Agent = "claude" | "codex"` with an open `AgentId` (string) derived from the registries, exactly as `TargetId` derives from `TARGET_REGISTRY`. `SessionStat.agent`, attestation `source.harness.id`, and scan code widen accordingly. This is the load-bearing refactor; it lands in Phase 0 with no behavior change.

**Gem = common core + two orthogonal overlays.**

```ts
interface Gem {
  // ── common attributes (portable neutral core — what the Gem IS; SIGNED) ──
  name: string;
  createdFrom: string;
  artifacts: GemArtifact[];        // by-value or by-reference (see §2)
  checks: GemCheck[];
  requiredSecrets: SecretRequirement[];
  grade?: number;
  cut?: string;
  // ── bindings (how it RUNS on a harness — UNSIGNED overlay; see §3) ──
  bindings: AgentBinding[];
}
```

The **signed digest commits to the core only** (name + artifacts, where a by-reference artifact contributes its `ref.id` + pinned `ref.digest` + checks + requiredSecrets + grade). Bindings and any resolved reference bytes are **outside** the digest, so identity is stable while bindings accrue.

### 2. Artifacts: by-value / by-reference (storage axis)

```ts
type GemArtifact =
  | { by: "value";     type: ArtifactType; name: string; /* embedded content */ }
  | { by: "reference"; type: ArtifactType; name: string; ref: ArtifactRef };

interface ArtifactRef {
  kind: "package" | "gem";   // this pass; "skill" | "url" are follow-ons
  id:   string;              // npx/npm spec  |  registry gem digest
  digest?: string;           // pinned in the LOCK at resolve time
}
```

- **Resolution reuses existing machinery.** The archive is already manifest **+ lock**; by-reference artifacts are resolved at install/materialize and pinned to `digest` in the lock, through the existing SSRF-guarded/registry-resolve path. No new fetch stack.
- **Resolution policy is per-kind, not global:**
  - `package` (npx/npm MCP server) — **stays a reference in the target**. Materializing to Cursor writes `.cursor/mcp.json` with `command: "npx", args: ["@foo/bar"]`; bytes are never inlined.
  - `gem` (registry dependency) — resolves to files at materialize; this edge *is* the composable-Gem dependency graph behind dependents-count / royalties.
- **Import prefers references.** A `SourceSpec` that reads an already-addressable artifact (an `npx` MCP server, a published skill) emits a **reference**, not a re-embedded copy. Only local/bespoke content is embedded `by: "value"`. This mirrors the attestation ingredient model (public = by id/reference, private = opaque).

### 3. Bindings: per-harness execution (execution axis, delta-only)

```ts
interface AgentBinding {
  agent: AgentId;                     // which harness this binding is for
  origin: "imported" | "rendered";    // provenance: mined FROM here, or exported TO here
  model?: string;                     // harness-pinned model, if the author set one
  entry?: string;                     // command / entrypoint / mode to invoke
  secretMap?: Record<string, string>; // requiredSecret name → this harness's env var NAME
  config?: Record<string, unknown>;   // small harness knobs (trust, autoApprove, …)
}
```

**Delta-only:** a binding holds only what the neutral artifacts cannot express. The materialized files are re-rendered from the core by the `TargetSpec` on demand — single source of truth, lean Gem, thin overlay. `secretMap` references env-var **names**, never values.

`bindings[]` powers marketplace "**runs on:** Claude · Cursor · Cline" straight from stored data, and is the per-harness execution contract the ACP / AgentCore runners already need.

### 4. Symmetric registries, keyed by `AgentId`

**Inbound — `SourceSpec`** (pure descriptor in `@agentgem/model`; FS-touching methods run server-side):

```ts
interface SourceSpec {
  id: AgentId;                          // "cline" | "gemini" | "continue" | "cursor" | ...
  label: string;
  traits: { storage: "jsonl" | "json" | "sqlite" | "mixed" };  // UI/ingestion hint
  roots(env: SourceEnv): string[];                              // may be empty (agent absent)
  scanSessions?(roots: string[]): SessionStat[];                // capability: telemetry/usage
  readArtifacts?(roots: string[]): ImportResult;                // capability: authoring
}

interface ImportResult { artifacts: GemArtifact[]; binding: AgentBinding /* origin:"imported" */ }
```

- **Capability by presence.** An agent missing a stream simply omits the method; partial agents degrade gracefully.
- **Storage hidden behind the interface.** SQLite-vs-JSONL lives *inside* each spec; the contract only promises normalized `SessionStat` / `GemArtifact` out.
- **Shared sub-parsers** for the convergent formats: `parseMcpServers` (universal `mcpServers` schema), `readMarkdownInstructions`.
- `scanSessions()` (top-level, `packages/insight`) becomes registry-driven: for each registered spec with the capability, fold in its `SessionStat[]`. `resolveDirs()` generalizes to per-spec `roots()`.

**Outbound — `TargetSpec`** (exists): extend so `cursor` / `cline` / `gemini` / `continue` render a Gem into each agent's **native layout** (from the inventory). When materializing, a target uses `core` + the binding for that agent if present, else synthesizes an `origin: "rendered"` binding.

An **"agent"** is anything with a source, a target, or both. The two registries share `AgentId`.

### 5. Extension point (AgentBack) — mirrors `GEM_TYPES`

```ts
export const AGENT_SOURCES = "agentgem.agentSources";

@extensionPoint(AGENT_SOURCES)
export class SourceRegistry {
  constructor(@extensions.list(AGENT_SOURCES) private specs: SourceSpec[]) {}
  all(): SourceSpec[] { return [...this.specs]; }
  byId(id: AgentId): SourceSpec | undefined { return this.specs.find(s => s.id === id); }
}

export class AgentSourcesComponent implements Component {
  bindings = BUILTIN_SOURCES.map(spec =>
    Binding.bind(`agentSources.${spec.id}`).to(spec).apply(extensionFor(AGENT_SOURCES)));
  services = [SourceRegistry];
}
// src/index.ts:  app.component(AgentSourcesComponent);
```

A new agent = one bound `SourceSpec` (a plugin `ctx.add(Binding.bind(...).to(spec).apply(extensionFor(AGENT_SOURCES)))`). No fork of `scanSessions()`. Consumers inject `@service(SourceRegistry, { optional: true })` with a built-in fallback for non-DI callers/tests, exactly as `GemController` does for `GemTypeRegistry`.

### 6. Round-trip flow

```
Cursor workspace ──SourceSpec.readArtifacts()──▶ Gem { core (refs preferred) + imported binding }
                                                     │
                                          publish / distill / compose
                                                     │
Gem ──TargetSpec (materialize + binding)──▶ Cline layout  (.clinerules + cline_mcp_settings.json + skills)
```

Import a Cursor setup, publish a Gem, materialize it back into Cursor *or* cross-pollinate into Claude/Cline — the binding carries what the neutral core can't, `package` refs stay live, `gem` refs pull dependencies.

---

## Build sequence

- **Phase 0 — neutral spine.** `Agent` closed union → open `AgentId`; add `AgentBinding` + `Gem.bindings[]`; add the by-value/by-reference `GemArtifact` discriminant + `ArtifactRef` (`package`, `gem`); confirm digest boundary (sign core incl. reference id+digest, exclude bindings). No new agents. **Guard: full existing suite stays green.**
- **Phase 1 — extension point.** `AGENT_SOURCES` + `SourceRegistry` + `AgentSourcesComponent` (mirror `GEM_TYPES`). Refactor the existing claude/codex parsers into two built-in `SourceSpec`s; make `scanSessions()` registry-driven. Behavior unchanged → validated against current fixtures.
- **Phase 2 — Cline/Roo round-trip (the proof).** `SourceSpec` (sessions from `tasks/*/`, usage from `api_req_started`, artifacts incl. `mcpServers` as references + `.clinerules`, `imported` binding) **and** `TargetSpec` (render Gem → Cline native layout). Golden-fixture round-trip test.
- **Phase 3 — fan out as pure plug-ins** (no core change): Gemini CLI → Continue → **Cursor last** (SQLite stress-test). Each a SourceSpec + TargetSpec.

This spec covers **Phase 0–2**. Phase 3 agents are follow-on specs.

## Privacy & per-adapter hazards (spec requirements)

- **Metadata-only telemetry** — sessions yield tokens/model/timestamps, never message text (unchanged boundary). Fits Continue `dev_data/tokensGenerated.jsonl`, Gemini per-msg `tokens`, Cline `api_req_started`, Cursor bubble `tokenCount`.
- **Secrets never ingested** — MCP `env`/`headers` and oauth files redacted on import; `secretMap` holds env-var names only.
- **Per-adapter** — Cursor: copy SQLite before read (WAL locks), double-encoded JSON, multi-DB union, version churn; Gemini: fold `$rewindTo`/`$set` mutation lines, slug via `projects.json`; Cline: double-parse `api_req_started`, dedup tasks across Code/Cursor/Windsurf; Continue: `noCode`-vs-`all` levels, wildcard version-dir glob.
- **Absent installs are normal** — `roots()` empty ⇒ spec contributes nothing, never throws.

## Testing

- Phase 0/1 validated against existing claude/codex fixtures — **behavior must not change**.
- New adapters use **synthetic golden fixtures** (transcripts / task dirs / a tiny SQLite), not the real FS — none of the four agents is installed here, and real-FS scan tests are known to flake under full-suite concurrency. Keep adapter tests fixture-based and isolated.
- Phase 2 acceptance: a Cline fixture → Gem → materialize-to-Cline round-trip reproduces the setup; usage sums match; MCP servers survive as `package` references.

## Risks / open questions

- **`AgentId` widening blast radius** — it threads through `SessionStat`, attestations, schemas (`TargetIdSchema`-style enums). Phase 0 must enumerate every site; the closed-union → open-string change is where regressions hide.
- **Digest recomputation** — confirm the exact fields the current attestation/lock digest hashes before drawing the core/overlay line, so adding `bindings[]` and the artifact discriminant doesn't shift existing gem digests.
- **`gem` reference cycles** — dependency resolution needs cycle detection (reuse registry merge guards if present).
- **Cursor version churn** — the SQLite schema has changed repeatedly; the Phase 3 Cursor spec must be version-tolerant and copy-before-read.

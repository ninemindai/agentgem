# agentgem — Pack Checks: an embedded, portable verification contract (Design)

**Date:** 2026-06-16
**Status:** Approved design, pre-implementation
**Project:** `agentgem` (`/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** Give every Pack a self-contained set of **checks** — behavioral evals ("does it work") and external security/static scans ("is it safe") — plus a declared **secret surface** (`requiredSecrets`, names only). agentgem *authors, scaffolds, validates, and embeds* checks into the Pack; it does **not** run them. Execution belongs to the step-5/7 substrate (Flue sandbox). This makes the Pack a verifiable contract about itself, which is the unit steps 5–7 (verify, publish, certify) can consume.

---

## 0. Motivation

Today a `Pack` is `{ name, createdFrom, artifacts[] }` — a redacted snapshot with no notion of whether it *works* or is *safe to run*. That leaves steps 3, 5, and 7 of the platform lifecycle doing trust by assertion ("worked on my machine"). One primitive collapses them: a verification artifact that **travels inside the pack** and is reproducibly runnable in a clean sandbox. The author writes it (scaffolded), the sandbox runs it, the platform certifies the green run.

Two trust-boundary halves come with it:
- **Producer side (secrets):** redaction currently destroys both secret *values* and their *names*. A pack with redacted MCP secrets can't run, and nobody knows what it needs. We preserve the **names** as a declared `requiredSecrets` surface so a runtime can inject values; values themselves are never emitted.
- **Consumer side (safety):** redaction protects the *author's* secrets but does nothing to protect a *consumer* from a hostile pack. External security scanners (e.g. NVIDIA **SkillSpector**) are the consumer-protection mechanism, expressed as a check kind.

## 1. Design decisions (locked)

1. **Checks are behavioral** — install the pack into a clean agent, give it a task, judge completion. (A static-only check is expressible as the `external` kind below.)
2. **Authoring is scaffold-then-refine** — agentgem drafts checks from the artifacts; the operator edits/owns the final checks. Never silently auto-committed.
3. **Judging is deterministic-first** — machine-checkable assertions are the primary pass/fail signal; an LLM-judge rubric is an opt-in escape hatch for fuzzy tasks.
4. **agentgem embeds; the platform executes** — agentgem authors + validates + embeds checks and owns the *result/report types*, but runs no agent and bundles no scanner.
5. **Attachment is a top-level `Pack.checks` field** (not a `PackArtifact` union member, not a sidecar) — a check describes the pack; an artifact is installed *into* the agent. Different questions → different fields; keeps the install path (`for artifact of artifacts: install`) free of guards.
6. **`checks` is a discriminated union** (`behavioral | external`) — a third kind later (perf, cost) is a new member, not a schema rewrite. Mirrors the existing `PackArtifact` union; preserves conceptual integrity.
7. **Secret surface is declared, names only** — redaction records `{name, location}` for everything it redacts; `requiredSecrets` aggregates them. Values are never emitted anywhere.

## 2. Data model (`src/pack/types.ts`)

```ts
export interface Pack {
  name: string;
  createdFrom: string;
  artifacts: PackArtifact[];
  checks: PackCheck[];                  // 0..n; scaffold proposes 1 behavioral + 1 security
  requiredSecrets: SecretRequirement[]; // declared secret surface; names only, never values
}

// ── Secret surface ───────────────────────────────────────────────
export interface SecretRequirement {
  name: string;        // leaf key, e.g. "OPENAI_API_KEY"
  artifact: string;    // owning artifact, e.g. mcp server "context7"
  location: string;    // re-injection path, e.g. "env.OPENAI_API_KEY" | "headers.Authorization"
  // never a value
}

// ── Checks (discriminated union) ─────────────────────────────────
export type PackCheck = BehavioralCheck | ExternalCheck;

export interface BehavioralCheck {
  kind: "behavioral";
  name: string;                 // stable id, e.g. "redacts-mcp-secrets"
  description?: string;
  task: string;                 // prompt given to the clean, pack-loaded agent
  setup?: EvalSetup;            // optional workspace seeding before the run
  assertions: EvalAssertion[];  // deterministic; ALL must pass (AND, no hidden OR)
  judge?: EvalJudge;            // opt-in LLM-judge; if set, pass requires assertions AND judge>=threshold
  timeoutSec?: number;          // run budget; default 300
}

export interface ExternalCheck {
  kind: "external";
  name: string;
  description?: string;
  runner: string;               // registry id, e.g. "skillspector"
  with?: Record<string, unknown>; // runner config, e.g. { failAboveRisk: 40 }
}

export interface EvalSetup {
  files?: { path: string; content: string }[]; // seed files in the run workspace
}

// Deterministic, machine-checkable. Same discriminated-union style as PackArtifact.
export type EvalAssertion =
  | { type: "file_exists";      path: string }
  | { type: "file_contains";    path: string; substring: string }
  | { type: "command_succeeds"; command: string }   // exit 0
  | { type: "output_contains";  substring: string } // agent's final message
  | { type: "tool_called";      tool: string };     // a given MCP/agent tool was invoked

export interface EvalJudge {
  rubric: string;               // what "good" looks like
  passThreshold?: number;       // 0..1, default 0.7
}
```

## 3. Execution contract (agentgem owns the types; the platform implements the runner)

agentgem runs nothing, but ships the result types so runner and agentgem agree on one shape. A conforming runner: **provision a clean agent → install the pack's artifacts (rebinding `requiredSecrets`) → for each check: apply `setup`, run under `timeoutSec`, evaluate → emit `CheckResult` → aggregate to `PackVerificationReport`.**

```ts
export interface CheckResult {
  checkName: string;
  kind: "behavioral" | "external";
  passed: boolean;
  // behavioral:
  assertionResults?: { assertion: EvalAssertion; passed: boolean; detail?: string }[];
  judgeScore?: number;
  // external:
  runner?: string;
  score?: number;               // e.g. SkillSpector risk 0-100
  findings?: { severity: string; title: string; detail?: string }[]; // normalized SARIF
  durationMs: number;
  error?: string;               // harness failure (timeout, install error) ≠ check failure
}

export interface PackVerificationReport {
  packName: string;
  createdFrom: string;
  results: CheckResult[];
  passed: boolean;              // all checks passed AND checks.length > 0
}
```

**Named dependency, not solved here:** MCP servers can't run without secrets, so the runner needs a **secret-rebinding** step that reads `requiredSecrets`, resolves each `name` from a vault/operator, and writes it back at `location` before the run. agentgem's contribution is *declaring* that surface; resolution/injection is the runner's.

## 4. Runner registry (`src/pack/checks.ts`)

agentgem holds a tiny registry of **declarations only** — enough for the scaffolder and validator to know a runner is real and what it accepts. The adapter that actually shells out lives in the platform runner.

```ts
export const RUNNER_REGISTRY = {
  skillspector: {
    id: "skillspector",
    consumes: "pack-as-directory",     // Pack materializes to a dir of SKILL.md + config
    resultShape: "score+findings",
    defaultWith: { failAboveRisk: 40 },
  },
} as const;
```

A Pack materializes to a directory of skills + config, which is exactly what `skillspector scan [path]` consumes; the adapter normalizes its risk score + SARIF findings into `CheckResult.score` / `findings`.

## 5. Scaffolding (`src/pack/checks.ts`)

`scaffoldChecks(inventory, selection): PackCheck[]` returns editable **drafts**:
- One `behavioral` draft: a `task` synthesized from the dominant selected skill's description / instructions, with assertion **stubs** (honest: drafting a meaningful *task* is feasible; auto-generating good deterministic assertions mostly isn't — the operator fills these).
- One `external` draft `{ kind:"external", runner:"skillspector", with:{ failAboveRisk:40 } }` **whenever skills are present** — security-by-default, baking consumer protection into the default pack instead of bolting it on at step 7.

Drafts are suggestions only; nothing is committed until the operator includes them in a `pack` request.

## 6. Operations (one Zod contract → REST + MCP)

| Op | REST | MCP tool | Shape |
|----|------|----------|-------|
| `inventory` | `GET /api/inventory` | `inventory` | unchanged (artifacts now carry their `{name,location}` secret refs) |
| `scaffold_checks` | `POST /api/scaffold-checks` | `scaffold_checks` | `{ selection } → PackCheck[]` drafts |
| `pack` | `POST /api/pack` | `pack` | body gains optional `checks: PackCheck[]`; returns `Pack` with `checks` + `requiredSecrets` |

Stateless throughout (selection refers to artifacts by name; `pack` re-introspects). `scaffold_checks` as an MCP tool means the operator's local agent can ask agentgem to draft checks — on-thesis for agent-native.

## 7. Module changes

- `src/pack/redact.ts` — `redactMcpConfig` returns `{ config, secrets: {name, location}[] }` instead of just the redacted config. Same value-based + key-name-based detection; it now *records* what it redacted. **Only change to the trust boundary, and it strictly preserves it** (names out, values never).
- `src/pack/introspect.ts` — threads each artifact's redacted secrets onto the artifact via a new optional field `secretRefs?: { name: string; location: string }[]` on `McpServerArtifact` and `HookArtifact` (the two artifact kinds whose `config` can hold secrets), so the UI can show per-row "needs OPENAI_API_KEY". `buildPack` derives `Pack.requiredSecrets` by flattening the `secretRefs` of the selected artifacts (stamping each with its owning `artifact` name).
- `src/pack/buildPack.ts` — accepts `checks`; aggregates `requiredSecrets` from **only the selected** artifacts; attaches both to the `Pack` (defaults: `checks: []`, `requiredSecrets: []`).
- `src/pack/checks.ts` *(new)* — `scaffoldChecks(...)` and `RUNNER_REGISTRY`.
- `src/pack/types.ts` — the types in §2–§3.
- `src/schemas.ts` — zod v4 wire schemas: `SecretRequirementSchema`, `PackCheckSchema` (discriminated union), `EvalAssertionSchema`, `CheckResultSchema`, `PackVerificationReportSchema`; extend `PackSchema`; add `ScaffoldChecksRequest/Response`; extend the pack request body with optional `checks`. Schemas must agree with the pack-core TS types. `runner` validates against `RUNNER_REGISTRY` keys.
- `src/pack.controller.ts` — add `POST /api/scaffold-checks` (MCP tool `scaffold_checks`); extend `POST /api/pack` body.
- `src/public/index.html` — a **Checks panel** under the live preview. "Suggest checks" calls `scaffold_checks` → populates editable drafts (task, assertion stubs, security threshold). The page holds `currentChecks` state and sends it on every `POST /api/pack`, so preview and the downloaded `pack.json` always reflect operator edits.

## 8. Trust boundary (unchanged in spirit, sharpened)

Redaction still happens **at capture** (value-based + key-name-based), so every REST/MCP response and the rendered preview carry only redacted shapes. The single change: redaction now also emits the **names** it redacted as `requiredSecrets` (never values). Check text (`task`, `setup.files[].content`) passes through the same redaction pass — operator-authored test data must not leak a raw secret. Net: the producer's secrets stay protected, *and* the pack now declares its secret surface and its safety/behavior checks.

## 9. Testing

Following the existing port-style unit + `@agentback/testing` controller + gstack page-smoke pattern:

- **Unit (`src/pack/__tests__`):** redact returns `{name, location}` for both value- and key-name-detected secrets; `scaffoldChecks` yields a behavioral draft **and** a skillspector draft from seeded skills (and no skillspector draft when no skills selected); `buildPack` embeds `checks` and aggregates `requiredSecrets` from selected artifacts only; schema **rejects** an unknown `runner`, a malformed assertion `type`, and any stray `value` field on `SecretRequirement`.
- **Controller (`@agentback/testing`, port 0, temp fake `~/.claude`):** `POST /api/scaffold-checks` returns drafts; `POST /api/pack` with `checks` round-trips into `Pack.checks` and computes `requiredSecrets`; check text is redacted (no raw secret in a `task`/`setup`).
- **Page (gstack at verify time):** load `/`, toggle a skill, Checks panel shows both drafts, edit a task, Download → `pack.json` contains `checks[]` and `requiredSecrets[]` with **names not values**.

## 10. Out of scope (named dependencies, built elsewhere)

- The runners themselves — the behavioral agent-runner and the SkillSpector adapter live in the step-5/7 substrate (Flue), not agentgem.
- The secret **vault / injection** mechanism — agentgem declares `requiredSecrets`; resolving/injecting is the runner's job.
- Certification/signing of `PackVerificationReport` (step 7) — consumes these types, built later.
- Capturing checks from real step-3 "evolve workflows" runs; cross-agent (Codex/Hermes) normalization of artifacts/checks.
- Additional runners beyond `skillspector`; additional check kinds (perf, cost) — new union members / registry entries when needed.

## 11. Platform fit

This turns the Pack from a config blob into a **config blob + a verifiable contract about itself**: what it needs (`requiredSecrets`), that it works (`behavioral` checks), and that it's safe (`external` security checks). That contract is precisely what steps 5 (verify), 6 (publish), and 7 (certify) consume — certification becomes "the pack's checks ran green in a clean sandbox," not a signature on unexecuted config. agentgem's footprint stays small (one new module, one redact signature change, one new operation, one UI panel); everything executable is the platform's.

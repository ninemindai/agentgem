# Gem Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Gem a self-contained set of `checks` (behavioral evals + external security scans) and a declared `requiredSecrets` surface (names only), authored/scaffolded/validated/embedded by agentgem — without agentgem running anything.

**Architecture:** Redaction is upgraded to *record* the names+locations it strips (not just drop them); `buildPack` aggregates those into `Gem.requiredSecrets` and embeds operator-supplied `checks`. A new `scaffoldChecks` produces editable drafts (one behavioral, plus a SkillSpector security check when skills are present). Both surface through the existing one-Zod-contract → REST+MCP controller. Execution (the agent runner, the SkillSpector adapter, secret injection) is out of scope — agentgem owns the *types* and the *embedding*.

**Tech Stack:** TypeScript 6 (legacy decorators, `tsc -b` build), zod v4, AgentBack (`@agentback/rest|mcp|openapi`), vitest, `@agentback/testing`/supertest, vanilla-JS page. pnpm.

**Conventions for every task:**
- Run a single test file fast with `pnpm exec vitest run <path>`.
- Before each commit run the full gate `pnpm test` (it does `tsc -b && vitest run`, so it typechecks too — critical because these tasks change shared types).
- Work on branch `feat/gem-checks` (already checked out).

---

### Task 1: Redaction records the secret surface

Change `redactMcpConfig` to return `{ config, secrets }` (names + locations of every redacted value; never values), add the `SecretRef` type and a `secretRefs?` field to the two artifact kinds whose config holds secrets, and update the two call sites in `introspect.ts`.

**Files:**
- Modify: `src/gem/types.ts`
- Modify: `src/gem/redact.ts`
- Modify: `src/gem/introspect.ts:95-100` (`serversToArtifacts`), `src/gem/introspect.ts:111-123` (`hooksFromConfig`)
- Test: `src/gem/__tests__/redact.test.ts`

- [ ] **Step 1: Add the `SecretRef` type and `secretRefs?` fields**

In `src/gem/types.ts`, add the interface (place it above `SkillArtifact`):

```ts
export interface SecretRef {
  name: string;     // leaf key, e.g. "OPENAI_API_KEY"
  location: string; // dotted path within the artifact config, e.g. "env.OPENAI_API_KEY"
}
```

Add `secretRefs?: SecretRef[];` to `McpServerArtifact` (after `source?: string;`) and to `HookArtifact` (after `source?: string;`):

```ts
export interface McpServerArtifact {
  type: "mcp_server";
  name: string;
  transport: "stdio" | "http" | "sse";
  config: Record<string, unknown>;
  source?: string;
  secretRefs?: SecretRef[];   // names+locations redaction stripped from `config`
}
```

```ts
export interface HookArtifact {
  type: "hook";
  name: string;
  event: string;
  matcher?: string;
  config: Record<string, unknown>;
  source?: string;
  secretRefs?: SecretRef[];   // names+locations redaction stripped from `config`
}
```

- [ ] **Step 2: Update the existing redact tests to the new return shape, and add a secret-surface test**

In `src/gem/__tests__/redact.test.ts`, the three existing tests destructure the return value as the config. Change each `const out = redactMcpConfig({...});` to `const { config: out } = redactMcpConfig({...});` (3 occurrences). Then add this new test inside the `describe` block:

```ts
it("records the name + location of every redacted value, never the value", () => {
  const { config, secrets } = redactMcpConfig({
    command: "npx",
    env: { GITHUB_TOKEN: "ghp_realsecret", REGION: "us" },
    headers: { Authorization: "Bearer abc123" },
    apiKey: "sk-1234567890",
  });
  // values gone
  expect((config.env as Record<string, string>).GITHUB_TOKEN).toBe("<redacted>");
  // names + locations recorded
  const byLoc = Object.fromEntries(secrets.map((s) => [s.location, s.name]));
  expect(byLoc["env.GITHUB_TOKEN"]).toBe("GITHUB_TOKEN");
  expect(byLoc["env.REGION"]).toBe("REGION");           // under env => redacted by map rule
  expect(byLoc["headers.Authorization"]).toBe("Authorization");
  expect(byLoc["apiKey"]).toBe("apiKey");
  // no secret value leaks into the manifest
  expect(JSON.stringify(secrets)).not.toContain("ghp_realsecret");
  expect(JSON.stringify(secrets)).not.toContain("abc123");
});
```

- [ ] **Step 3: Run the redact test, watch it fail**

Run: `pnpm exec vitest run src/gem/__tests__/redact.test.ts`
Expected: FAIL — `redactMcpConfig(...).config`/`.secrets` are undefined (function still returns the bare config).

- [ ] **Step 4: Rewrite `redactMcpConfig` to record secrets**

Replace the entire contents of `src/gem/redact.ts` with:

```ts
// src/gem/redact.ts
// Strip secret VALUES from an MCP/hook config while preserving its shape, and record the
// NAME + LOCATION of every value stripped so a runtime can re-inject by name. Values never leave.
import type { SecretRef } from "./types.js";

const SECRET_RE = /(api[_-]?key|token|secret|password|passwd|bearer|sk-|ghp_|gho_|xox[a-z]-|credential)/i;

// A long, special-char-free token (no spaces, slashes, or dots) is almost
// certainly a secret; long sentences/paths/urls contain those characters.
function isHighEntropyToken(s: string): boolean {
  return s.length >= 32 && /^[A-Za-z0-9_-]+$/.test(s);
}

function redactNode(node: unknown, underSecretMap: boolean, path: string, key: string | undefined, secrets: SecretRef[]): unknown {
  if (typeof node === "string") {
    const keyIsSecret = key !== undefined && SECRET_RE.test(key);
    if (underSecretMap || keyIsSecret || SECRET_RE.test(node) || isHighEntropyToken(node)) {
      secrets.push({ name: key ?? path, location: path });
      return "<redacted>";
    }
    return node;
  }
  if (Array.isArray(node)) return node.map((x, i) => redactNode(x, underSecretMap, `${path}[${i}]`, key, secrets));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const secretMap = underSecretMap || k === "env" || k === "headers";
      out[k] = redactNode(v, secretMap, path ? `${path}.${k}` : k, k, secrets);
    }
    return out;
  }
  return node;
}

export function redactMcpConfig(config: Record<string, unknown>): { config: Record<string, unknown>; secrets: SecretRef[] } {
  const secrets: SecretRef[] = [];
  const redacted = redactNode(config, false, "", undefined, secrets) as Record<string, unknown>;
  return { config: redacted, secrets };
}
```

- [ ] **Step 5: Update the two call sites in `introspect.ts`**

Replace `serversToArtifacts` (currently `src/gem/introspect.ts:95-100`) with:

```ts
function serversToArtifacts(servers: Record<string, unknown>, source: string): McpServerArtifact[] {
  return Object.entries(servers).map(([name, cfg]) => {
    const config = isObj(cfg) ? cfg : {};
    const { config: redacted, secrets } = redactMcpConfig(config);
    return { type: "mcp_server", name, transport: inferTransport(config), config: redacted, source, secretRefs: secrets };
  });
}
```

In `hooksFromConfig` (currently `src/gem/introspect.ts:111-123`), replace the `out.push(...)` line with:

```ts
      const { config: redacted, secrets } = redactMcpConfig(g);
      out.push({ type: "hook", name: `${event}${matcher ? ` · ${matcher}` : ""}`, event, matcher, config: redacted, source, secretRefs: secrets });
```

- [ ] **Step 6: Run the full gate (typecheck + all tests)**

Run: `pnpm test`
Expected: PASS. (`introspect.test.ts` still passes — it asserts on `config.env.*` fields, which are unchanged; it never does whole-artifact equality.)

- [ ] **Step 7: Commit**

```bash
git add src/gem/types.ts src/gem/redact.ts src/gem/introspect.ts src/gem/__tests__/redact.test.ts
git commit -m "feat(gem): redaction records secret names+locations as secretRefs"
```

---

### Task 2: Gem gains `checks` + `requiredSecrets`; `buildPack` populates them

Add the check/result types, make `Gem` carry `checks` and `requiredSecrets`, and have `buildPack` accept operator `checks` and aggregate `requiredSecrets` from the *selected* artifacts only.

**Files:**
- Modify: `src/gem/types.ts`
- Modify: `src/gem/buildPack.ts`
- Test: `src/gem/__tests__/buildPack.test.ts`

- [ ] **Step 1: Add the check, secret-requirement, and result types**

In `src/gem/types.ts`, add (after the `SecretRef` interface from Task 1):

```ts
// ── Declared secret surface (aggregated onto the Gem) ──
export interface SecretRequirement {
  name: string;      // leaf key, e.g. "OPENAI_API_KEY"
  artifact: string;  // owning artifact name, e.g. mcp server "context7"
  location: string;  // re-injection path, e.g. "env.OPENAI_API_KEY"
  // never a value
}

// ── Checks (discriminated union: behavioral | external) ──
export type PackCheck = BehavioralCheck | ExternalCheck;

export interface BehavioralCheck {
  kind: "behavioral";
  name: string;
  description?: string;
  task: string;                 // prompt given to the clean, gem-loaded agent
  setup?: EvalSetup;            // optional workspace seeding
  assertions: EvalAssertion[];  // deterministic; ALL must pass (AND)
  judge?: EvalJudge;            // opt-in LLM-judge; pass = assertions AND judge>=threshold
  timeoutSec?: number;
}

export interface ExternalCheck {
  kind: "external";
  name: string;
  description?: string;
  runner: string;               // registry id, e.g. "skillspector"
  with?: Record<string, unknown>;
}

export interface EvalSetup {
  files?: { path: string; content: string }[];
}

export type EvalAssertion =
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; substring: string }
  | { type: "command_succeeds"; command: string }
  | { type: "output_contains"; substring: string }
  | { type: "tool_called"; tool: string };

export interface EvalJudge {
  rubric: string;
  passThreshold?: number; // 0..1, default 0.7
}

// ── Execution-result types (agentgem owns these; the platform runner produces them) ──
export interface CheckResult {
  checkName: string;
  kind: "behavioral" | "external";
  passed: boolean;
  assertionResults?: { assertion: EvalAssertion; passed: boolean; detail?: string }[];
  judgeScore?: number;
  runner?: string;
  score?: number;
  findings?: { severity: string; title: string; detail?: string }[];
  durationMs: number;
  error?: string;
}

export interface PackVerificationReport {
  packName: string;
  createdFrom: string;
  results: CheckResult[];
  passed: boolean; // all results passed AND results.length > 0
}
```

Then extend the `Gem` interface (currently `src/gem/types.ts:56-60`) to:

```ts
export interface Gem {
  name: string;
  createdFrom: string;
  artifacts: PackArtifact[];
  checks: PackCheck[];                   // 0..n; embedded operator checks
  requiredSecrets: SecretRequirement[];  // declared secret surface; names only
}
```

- [ ] **Step 2: Add the failing tests for embedding checks and aggregating secrets**

In `src/gem/__tests__/buildPack.test.ts`, update the `inv` fixture so the `gh` server carries `secretRefs`, and add two tests. Replace the `mcpServers` line of `inv` with:

```ts
  mcpServers: [{ type: "mcp_server", name: "gh", transport: "stdio", config: { env: { GH_TOKEN: "<redacted>" } }, secretRefs: [{ name: "GH_TOKEN", location: "env.GH_TOKEN" }] }],
```

Add these tests inside the `describe("buildPack", ...)` block:

```ts
it("embeds operator checks and defaults to empty when none given", () => {
  const withChecks = buildPack(inv, { skills: ["review"] }, {
    checks: [{ kind: "behavioral", name: "smoke", task: "do it", assertions: [] }],
  });
  expect(withChecks.checks.map((c) => c.name)).toEqual(["smoke"]);
  expect(buildPack(inv, { skills: ["review"] }).checks).toEqual([]);
});

it("aggregates requiredSecrets from selected artifacts only (names, never values)", () => {
  const withMcp = buildPack(inv, { mcpServers: ["gh"] });
  expect(withMcp.requiredSecrets).toEqual([{ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" }]);
  // a selection without the gh server carries no secret requirement
  expect(buildPack(inv, { skills: ["review"] }).requiredSecrets).toEqual([]);
});

it("redacts a secret accidentally embedded in operator check text", () => {
  const gem = buildPack(inv, { skills: ["review"] }, {
    checks: [{ kind: "behavioral", name: "smoke", task: "use token ghp_abcdefghijklmnopqrstuvwxyz0123", assertions: [] }],
  });
  expect(JSON.stringify(gem.checks)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
});
```

- [ ] **Step 3: Run the buildPack test, watch it fail**

Run: `pnpm exec vitest run src/gem/__tests__/buildPack.test.ts`
Expected: FAIL — `gem.checks`/`gem.requiredSecrets` are undefined (and a TS error if run via `pnpm test`).

- [ ] **Step 4: Implement in `buildPack`**

In `src/gem/buildPack.ts`, update the import line to add the new types, and import the redactor (operator check text is passed through the same capture-time redaction so an accidental secret can't ride along):

```ts
import type { ConfigInventory, Gem, PackArtifact, PackCheck, SecretRequirement } from "./types.js";
import { redactMcpConfig } from "./redact.js";
```

Change the `opts` parameter (currently `src/gem/buildPack.ts:25`) to:

```ts
  opts: { name?: string; createdFrom?: string; checks?: PackCheck[] } = {},
```

Replace the final `return` statement (currently `src/gem/buildPack.ts:73`) with:

```ts
  const requiredSecrets: SecretRequirement[] = [];
  for (const a of artifacts) {
    if ((a.type === "mcp_server" || a.type === "hook") && a.secretRefs) {
      for (const ref of a.secretRefs) requiredSecrets.push({ name: ref.name, artifact: a.name, location: ref.location });
    }
  }

  // Embed operator checks, but run each through redaction first: a check's task/setup is
  // operator-authored test data and must not smuggle a raw secret into the shared gem.
  const checks = (opts.checks ?? []).map(
    (c) => redactMcpConfig(c as unknown as Record<string, unknown>).config as unknown as PackCheck,
  );

  return {
    name: opts.name ?? "gem",
    createdFrom: opts.createdFrom ?? "unknown",
    artifacts,
    checks,
    requiredSecrets,
  };
```

- [ ] **Step 5: Run the full gate**

Run: `pnpm test`
Expected: PASS. (Existing buildPack tests assert on `gem.artifacts`/`gem.name` only — unaffected by the two new fields.)

- [ ] **Step 6: Commit**

```bash
git add src/gem/types.ts src/gem/buildPack.ts src/gem/__tests__/buildPack.test.ts
git commit -m "feat(gem): Gem carries checks + requiredSecrets; buildPack populates both"
```

---

### Task 3: `scaffoldChecks` + the runner registry

A pure module that drafts checks from a built Gem: always a behavioral draft; plus a SkillSpector security draft when the gem contains skills.

**Files:**
- Create: `src/gem/checks.ts`
- Test: `src/gem/__tests__/checks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/checks.test.ts`:

```ts
// src/gem/__tests__/checks.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldChecks, RUNNER_REGISTRY } from "../checks.js";
import type { Gem } from "../types.js";

function gem(over: Partial<Gem> = {}): Gem {
  return { name: "p", createdFrom: "/d", artifacts: [], checks: [], requiredSecrets: [], ...over };
}

describe("scaffoldChecks", () => {
  it("drafts a behavioral check plus a skillspector security check when skills are present", () => {
    const p = gem({ artifacts: [{ type: "skill", name: "review", description: "Review code", source: "standalone", content: "x" }] });
    const checks = scaffoldChecks(p);
    const beh = checks.find((c) => c.kind === "behavioral");
    const ext = checks.find((c) => c.kind === "external");
    expect(beh).toBeTruthy();
    expect(beh!.kind === "behavioral" && beh!.assertions).toEqual([]); // stubs: operator fills
    expect(beh!.kind === "behavioral" && beh!.task).toContain("Review code");
    expect(ext && ext.kind === "external" && ext.runner).toBe("skillspector");
    expect(ext && ext.kind === "external" && ext.with).toEqual(RUNNER_REGISTRY.skillspector.defaultWith);
  });

  it("drafts only a behavioral check when the gem has no skills", () => {
    const p = gem({ artifacts: [{ type: "instructions", name: "CLAUDE.md", content: "x" }] });
    const checks = scaffoldChecks(p);
    expect(checks.map((c) => c.kind)).toEqual(["behavioral"]);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm exec vitest run src/gem/__tests__/checks.test.ts`
Expected: FAIL — cannot find module `../checks.js`.

- [ ] **Step 3: Implement `src/gem/checks.ts`**

```ts
// src/gem/checks.ts
// Scaffold editable check drafts from a built Gem. Pure; runs nothing. The runner registry
// holds DECLARATIONS only — the adapters that actually execute live in the platform runner.
import type { Gem, PackArtifact, PackCheck } from "./types.js";

export const RUNNER_REGISTRY = {
  skillspector: {
    id: "skillspector",
    consumes: "gem-as-directory", // Gem materializes to a dir of SKILL.md + config
    resultShape: "score+findings",
    defaultWith: { failAboveRisk: 40 },
  },
} as const;

export function scaffoldChecks(gem: Gem): PackCheck[] {
  const skills = gem.artifacts.filter((a): a is Extract<PackArtifact, { type: "skill" }> => a.type === "skill");
  const lead = skills[0];
  const intent = lead?.description ?? lead?.name ?? "the bundled capability";

  const checks: PackCheck[] = [
    {
      kind: "behavioral",
      name: "smoke",
      description: "Draft — edit the task and add assertions before relying on this check.",
      task: `Using this gem, ${intent}. Then report what you did.`,
      assertions: [], // stubs: meaningful deterministic assertions are operator-authored
      timeoutSec: 300,
    },
  ];

  if (skills.length) {
    const reg = RUNNER_REGISTRY.skillspector;
    checks.push({ kind: "external", name: "security-scan", runner: reg.id, with: { ...reg.defaultWith } });
  }

  return checks;
}
```

- [ ] **Step 4: Run it, watch it pass; then the full gate**

Run: `pnpm exec vitest run src/gem/__tests__/checks.test.ts`
Expected: PASS.
Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/checks.ts src/gem/__tests__/checks.test.ts
git commit -m "feat(gem): scaffoldChecks + runner registry (behavioral + skillspector drafts)"
```

---

### Task 4: Wire schemas (validation + the new wire contract)

Add zod schemas for every new type, extend the artifact + gem schemas, add the `checks` field to the gem request, and add the scaffold-checks request/response schemas. `runner` validates against the registry keys.

**Files:**
- Modify: `src/schemas.ts`
- Test: `src/__tests__/schemas.test.ts`

- [ ] **Step 1: Add the failing schema tests**

In `src/__tests__/schemas.test.ts`, update the import line to:

```ts
import { InventorySchema, PackSchema, PackRequestSchema, PackCheckSchema, ScaffoldChecksResponseSchema } from "../schemas.js";
```

Update the existing "accepts a Gem" test to include the now-required fields:

```ts
it("accepts a Gem", () => {
  const pk = PackSchema.parse({
    name: "p",
    createdFrom: "/d",
    artifacts: [{ type: "instructions", name: "CLAUDE.md", content: "y" }],
    checks: [],
    requiredSecrets: [{ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" }],
  });
  expect(pk.artifacts.length).toBe(1);
  expect(pk.requiredSecrets[0].name).toBe("GH_TOKEN");
});
```

Add these new tests inside the `describe` block:

```ts
it("validates both check kinds and rejects an unknown runner", () => {
  PackCheckSchema.parse({ kind: "behavioral", name: "smoke", task: "do it", assertions: [{ type: "file_exists", path: "out.txt" }] });
  PackCheckSchema.parse({ kind: "external", name: "sec", runner: "skillspector", with: { failAboveRisk: 40 } });
  expect(() => PackCheckSchema.parse({ kind: "external", name: "sec", runner: "totally-made-up" })).toThrow();
  expect(() => PackCheckSchema.parse({ kind: "behavioral", name: "x", task: "t", assertions: [{ type: "nope" }] })).toThrow();
});

it("accepts a gem-request carrying checks, and a scaffold-checks response", () => {
  const p = PackRequestSchema.parse({ selection: { all: true }, checks: [{ kind: "external", name: "s", runner: "skillspector" }] });
  expect(p.checks?.length).toBe(1);
  const r = ScaffoldChecksResponseSchema.parse({ checks: [{ kind: "behavioral", name: "smoke", task: "t", assertions: [] }] });
  expect(r.checks[0].name).toBe("smoke");
});
```

- [ ] **Step 2: Run the schema test, watch it fail**

Run: `pnpm exec vitest run src/__tests__/schemas.test.ts`
Expected: FAIL — `PackCheckSchema` / `ScaffoldChecksResponseSchema` are not exported.

- [ ] **Step 3: Add the schemas**

In `src/schemas.ts`, add this import at the top (below the existing `import { z } from "zod";`):

```ts
import { RUNNER_REGISTRY } from "./gem/checks.js";
```

Add `secretRefs` to the two artifact schemas. In `McpServerArtifactSchema` and `HookArtifactSchema`, add this field (before the closing `})`):

```ts
  secretRefs: z.array(z.object({ name: z.string(), location: z.string() })).optional(),
```

Add the new schemas (place them after `PackArtifactSchema`, before `ProjectInventorySchema`):

```ts
export const SecretRequirementSchema = z.object({
  name: z.string(),
  artifact: z.string(),
  location: z.string(),
});

export const EvalAssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file_exists"), path: z.string() }),
  z.object({ type: z.literal("file_contains"), path: z.string(), substring: z.string() }),
  z.object({ type: z.literal("command_succeeds"), command: z.string() }),
  z.object({ type: z.literal("output_contains"), substring: z.string() }),
  z.object({ type: z.literal("tool_called"), tool: z.string() }),
]);

export const BehavioralCheckSchema = z.object({
  kind: z.literal("behavioral"),
  name: z.string(),
  description: z.string().optional(),
  task: z.string(),
  setup: z.object({ files: z.array(z.object({ path: z.string(), content: z.string() })).optional() }).optional(),
  assertions: z.array(EvalAssertionSchema),
  judge: z.object({ rubric: z.string(), passThreshold: z.number().min(0).max(1).optional() }).optional(),
  timeoutSec: z.number().optional(),
});

// runner validates against the registry keys, so a gem can't declare a check no runner can run.
const RUNNER_IDS = Object.keys(RUNNER_REGISTRY) as [string, ...string[]];
export const ExternalCheckSchema = z.object({
  kind: z.literal("external"),
  name: z.string(),
  description: z.string().optional(),
  runner: z.enum(RUNNER_IDS),
  with: z.record(z.string(), z.unknown()).optional(),
});

export const PackCheckSchema = z.discriminatedUnion("kind", [BehavioralCheckSchema, ExternalCheckSchema]);
```

Extend `PackSchema` (currently `src/schemas.ts:95-99`) to:

```ts
export const PackSchema = z.object({
  name: z.string(),
  createdFrom: z.string(),
  artifacts: z.array(PackArtifactSchema),
  checks: z.array(PackCheckSchema),
  requiredSecrets: z.array(SecretRequirementSchema),
});
```

Add `checks` to `PackRequestSchema` (currently `src/schemas.ts:82-87`), inserting before the closing `})`:

```ts
  checks: z.array(PackCheckSchema).optional(),
```

Add the scaffold-checks schemas (place after `PackRequestSchema`):

```ts
export const ScaffoldChecksRequestSchema = z.object({
  selection: PackSelectionSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
});

export const ScaffoldChecksResponseSchema = z.object({ checks: z.array(PackCheckSchema) });
```

- [ ] **Step 4: Run the schema test, watch it pass; then the full gate**

Run: `pnpm exec vitest run src/__tests__/schemas.test.ts`
Expected: PASS.
Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/__tests__/schemas.test.ts
git commit -m "feat(gem): zod schemas for checks, requiredSecrets, scaffold-checks; registry-validated runner"
```

---

### Task 5: Controller — `scaffold_checks` op + `gem` embeds checks

Expose `scaffold_checks` (REST `POST /api/scaffold-checks`, MCP tool `scaffold_checks`) and pass operator `checks` through `gem`.

**Files:**
- Modify: `src/gem.controller.ts`
- Test: `src/__tests__/gem.controller.test.ts`

- [ ] **Step 1: Add failing controller tests**

In `src/__tests__/gem.controller.test.ts`, add these tests inside the `describe("GemController", ...)` block (the existing `beforeAll` seeds a `gh` MCP server with `env.GH_TOKEN` and a `review` skill):

```ts
it("POST /api/gem embeds checks and declares requiredSecrets (names, not values)", async () => {
  const r = await client
    .post("/api/gem")
    .send({
      dir,
      selection: { skills: ["review"], mcpServers: ["gh"] },
      checks: [{ kind: "behavioral", name: "smoke", task: "do it with ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", assertions: [] }],
    })
    .expect(200);
  expect(r.body.checks.map((c: { name: string }) => c.name)).toEqual(["smoke"]);
  expect(r.body.requiredSecrets).toContainEqual({ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" });
  expect(JSON.stringify(r.body)).not.toContain("ghp_secret"); // MCP secret value never present
  expect(JSON.stringify(r.body.checks)).not.toContain("ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"); // check text redacted too
});

it("POST /api/scaffold-checks returns editable drafts (behavioral + skillspector for a skill)", async () => {
  const r = await client.post("/api/scaffold-checks").send({ dir, selection: { skills: ["review"] } }).expect(200);
  const kinds = r.body.checks.map((c: { kind: string }) => c.kind);
  expect(kinds).toContain("behavioral");
  expect(kinds).toContain("external");
});
```

- [ ] **Step 2: Run the controller test, watch it fail**

Run: `pnpm exec vitest run src/__tests__/gem.controller.test.ts`
Expected: FAIL — `/api/scaffold-checks` 404s; `r.body.checks` undefined on the gem response.

- [ ] **Step 3: Implement the controller changes**

In `src/gem.controller.ts`, update the imports:

```ts
import { buildPack } from "./gem/buildPack.js";
import { scaffoldChecks } from "./gem/checks.js";
```

```ts
import {
  InventorySchema, PackSchema, PackRequestSchema, DirQuerySchema, PickQuerySchema, PickFolderSchema,
  ScaffoldChecksRequestSchema, ScaffoldChecksResponseSchema,
} from "./schemas.js";
```

Replace the `gem` handler (currently `src/gem.controller.ts:18-23`) with:

```ts
  @post("/gem", { body: PackRequestSchema, response: PackSchema })
  async gem(input: { body: z.infer<typeof PackRequestSchema> }): Promise<z.infer<typeof PackSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    return buildPack(inventory, input.body.selection, {
      name: input.body.name ?? "gem",
      createdFrom: dirs.claudeDir,
      checks: input.body.checks,
    });
  }

  @post("/scaffold-checks", { body: ScaffoldChecksRequestSchema, response: ScaffoldChecksResponseSchema })
  async scaffoldChecks(input: { body: z.infer<typeof ScaffoldChecksRequestSchema> }): Promise<z.infer<typeof ScaffoldChecksResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildPack(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir });
    return { checks: scaffoldChecks(gem) };
  }
```

- [ ] **Step 4: Run the controller test, watch it pass; then the full gate**

Run: `pnpm exec vitest run src/__tests__/gem.controller.test.ts`
Expected: PASS.
Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(api): scaffold_checks op + gem embeds checks (REST + MCP)"
```

---

### Task 6: Page — Checks panel (scaffold + edit + embed)

Add a "Suggest checks" flow and a per-check editor to the right pane; route the operator's checks into the live `POST /api/gem` so the preview and the downloaded `gem.json` always carry them. The page is verified with the gstack browser (per the project's smoke-test convention), not vitest.

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: Add the Checks panel markup**

In `src/public/index.html`, inside `<section class="pane right">`, immediately after the `<p class="note">…</p>` line (currently line 84), add:

```html
    <div id="checksPanel" class="group" style="margin-top:14px">
      <div class="bar"><strong style="flex:1">Checks</strong><button id="suggestChecks" class="ghost">Suggest checks</button></div>
      <div id="checksList"></div>
    </div>
```

- [ ] **Step 2: Add check state + rendering, and refactor `build()` to share selection assembly**

In the `<script>`, replace the entire `build()` function (currently lines 268-299) with the following — it factors the request-body assembly into `buildSelectionBody()` (reused by scaffold) and threads `currentChecks` into the gem request:

```js
let currentChecks = [];
// Assemble the selection request body, pruning stale names to what's currently in the inventory.
// (A stale checkbox after a project removal/reload would make buildPack throw -> opaque 500.)
function buildSelectionBody(){
  const has = (arr, n) => arr.some(x => x.name === n);
  const skills = [...sel.skills].filter(n => has(inv.skills, n));
  const mcpServers = [...sel.mcpServers].filter(n => has(inv.mcpServers, n));
  const hooks = [...sel.hooks].filter(n => has(inv.hooks, n));
  const projectsSel = {};
  for (const p of inv.projects || []) {
    const ps = sel.projects[p.root];
    if (!ps) continue;
    const o = {};
    const s = [...ps.skills].filter(n => has(p.skills, n));
    const m = [...ps.mcpServers].filter(n => has(p.mcpServers, n));
    const hk = [...ps.hooks].filter(n => has(p.hooks, n));
    if (s.length) o.skills = s;
    if (m.length) o.mcpServers = m;
    if (ps.includeInstructions && p.instructions.length) o.includeInstructions = true;
    if (hk.length) o.hooks = hk;
    if (Object.keys(o).length) projectsSel[p.root] = o;
  }
  const selection = { skills, mcpServers, includeInstructions: sel.includeInstructions };
  if (hooks.length) selection.hooks = hooks;
  if (Object.keys(projectsSel).length) selection.projects = projectsSel;
  const reqBody = { selection, name: document.getElementById("name").value || "gem" };
  if (projects.length) reqBody.projects = projects;
  return reqBody;
}
async function build(){
  const reqBody = buildSelectionBody();
  reqBody.checks = currentChecks;
  const gem = await (await fetch("/api/gem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reqBody) })).json();
  window.__gem = gem;
  renderPreview();
}
// Each check renders as an editable JSON textarea (operator refines task/assertions/threshold).
function renderChecks(){
  const el = document.getElementById("checksList");
  if (!currentChecks.length){ el.innerHTML = `<p class="d">No checks. Click "Suggest checks" to scaffold a behavioral + security draft, then edit.</p>`; return; }
  el.innerHTML = currentChecks.map((c, i) =>
    `<div class="group"><h2>${esc(c.kind)} · ${esc(c.name)}</h2><textarea data-ci="${i}" style="width:100%;min-height:120px;font:12px/1.5 ui-monospace,monospace;border:1px solid var(--line);border-radius:6px;padding:8px">${esc(JSON.stringify(c, null, 2))}</textarea></div>`).join("");
}
document.getElementById("checksList").addEventListener("change", e => {
  const ta = e.target.closest("textarea[data-ci]"); if (!ta) return;
  try { currentChecks[+ta.dataset.ci] = JSON.parse(ta.value); ta.style.borderColor = ""; build(); }
  catch { ta.style.borderColor = "var(--accent)"; } // invalid JSON: flag it, keep last good value
});
document.getElementById("suggestChecks").addEventListener("click", async () => {
  const r = await (await fetch("/api/scaffold-checks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildSelectionBody()) })).json();
  currentChecks = Array.isArray(r.checks) ? r.checks : [];
  renderChecks(); build();
});
```

- [ ] **Step 3: Render the (empty) panel on first paint**

At the end of the `<script>`, change the final `load();` line to:

```js
renderChecks();
load();
```

- [ ] **Step 4: Build and serve**

Run: `pnpm build && pnpm start`
Expected: prints `127.0.0.1:<port>`. Leave it running for the next step.

- [ ] **Step 5: Verify with the gstack browser**

Drive the served URL with the `browse`/gstack skill and confirm:
1. Load `/` — the Checks panel shows the empty hint.
2. Tick a skill on the left, click **Suggest checks** — two drafts appear (`behavioral · smoke` and `external · security-scan`).
3. Edit the behavioral textarea's `task` string; switch the preview to **JSON**.
4. The preview's `checks[]` reflects the edit, and `requiredSecrets[]` lists secret **names** (e.g. for a selected MCP server) with **no secret values** anywhere in the JSON.
5. Click **Download** — the saved `gem.json` contains `checks` and `requiredSecrets`.

Expected: all five hold. If `requiredSecrets` is empty, ensure the selected set includes an MCP server that has secrets.

- [ ] **Step 6: Commit**

```bash
git add src/public/index.html
git commit -m "feat(ui): Checks panel — scaffold, edit, and embed checks into the gem"
```

---

## Verification checklist (after all tasks)

- [ ] `pnpm test` is green (typecheck + all unit/controller tests).
- [ ] `GET /openapi.json` lists `POST /api/scaffold-checks` (free from AgentBack — sanity-check the contract surfaced).
- [ ] A built `gem.json` round-trips through `PackSchema` with `checks` + `requiredSecrets` present.
- [ ] No secret value appears anywhere in a gem response (`requiredSecrets` carries names only).

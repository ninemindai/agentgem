# Cross-Agent Verification Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One call runs a Gem against its own contract across the local ACP agent roster, returning a deterministic per-agent compatibility matrix, with every run ledgered.

**Architecture:** A new `verifyGemAcrossAgents` orchestrator in `@agentgem/run` loops the roster sequentially — availability check first (no run dir, no download by default), then the existing `materializeAndRunGem` in a per-agent dir, verdict from the verification report, ledger append per run. A blocking `POST /api/gem/verify` and an `agentgem verify` CLI subcommand expose it. Spec: `docs/superpowers/specs/2026-07-02-gem-verify-matrix-design.md`.

**Tech Stack:** TypeScript ESM monorepo (pnpm), vitest from compiled `dist/` (`pnpm exec tsc -b && pnpm exec vitest run dist/<path>.test.js`), supertest for the endpoint, Zod schemas in `src/schemas.ts`.

## Global Constraints

- Working dir: the `../agentgem-gem-verify` worktree, branch `gem-verify`.
- `fetch` defaults to **false**: a missing adapter is an `"unavailable"` verdict, never a download.
- Sequential execution; no concurrency option in this slice.
- Contract-only: no loose task/expectations overrides; no contract → `InvalidInputError` (400 at endpoint, exit 2 at CLI) before any agent runs.
- Ledger appends reuse phase-1 `appendVerification` (best-effort, never throws) — the orchestrator appends; the endpoint/CLI must NOT double-append.
- No console (`packages/console`) code changes. Node built-ins only; no new dependencies. Commits follow `feat(scope):`/`test(scope):`.
- Plan refinement over the spec (flag to reviewers, do not "fix" back): the shared base-dir helper `deriveMatrixBaseDir` lives in `verifyMatrix.ts` so the endpoint and CLI share one hardened sanitizer, and the hermetic unavailability seam is a `resolveAdapter` option (not an `installer`) — same spec intent, cleaner injection.

---

### Task 1: `verifyGemAcrossAgents` orchestrator

**Files:**
- Create: `packages/run/src/verifyMatrix.ts`
- Modify: `packages/run/src/index.ts` (add `export * from "./verifyMatrix.js";`)
- Test: `src/gem/__tests__/verifyMatrix.test.ts` (new)

**Interfaces:**
- Consumes (all existing in `@agentgem/run` / workspace deps): `materializeAndRunGem`, `resolveOrFetchAdapter`, `AGENT_ADAPTERS`, `AgentId`, `AgentAdapter`, `RunConnectFn`, `hasTestConnectFn`, `contractToExpectations`, `appendVerification`, `VerificationReport` (from `./gemVerify.js` etc.); `readGemMeta`, `writeGemArchive` from `@agentgem/archive`; `Gem`, `GemContract`, `InvalidInputError`, `agentgemHome` from `@agentgem/model`; `join`, `resolve`, `sep` from `node:path`.
- Produces (Tasks 2–3 rely on these exact names): `interface AgentVerdict { agent: AgentId; status: "passed" | "failed" | "unavailable"; verification?: VerificationReport; detail?: string }`; `interface VerifyMatrixOptions { gem: Gem; baseDir: string; contract?: GemContract; roster?: AgentId[]; fetch?: boolean; onVerdict?: (v: AgentVerdict) => void; connectFn?: RunConnectFn; resolveAdapter?: typeof resolveOrFetchAdapter; home?: string }`; `verifyGemAcrossAgents(opts): Promise<AgentVerdict[]>`; `deriveMatrixBaseDir(gemName: string, home?: string): string`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/verifyMatrix.test.ts`:

```ts
// src/gem/__tests__/verifyMatrix.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyGemAcrossAgents, deriveMatrixBaseDir, ledgerPath } from "@agentgem/run";
import type { RunConnectFn, ToolInvocation } from "@agentgem/run";
import type { Gem } from "@agentgem/model";

const gem: Gem = {
  name: "mx-gem",
  createdFrom: "test",
  artifacts: [{ type: "skill", name: "qa", source: "standalone", content: "# QA" }],
  checks: [],
  requiredSecrets: [],
  contract: { task: "exercise qa", expect: { tools: ["qa"] } },
};

// One fake serving both agents: the run dir ends with the agent id, so the fake
// invokes the contract-matching tool only in the claude dir — claude passes,
// codex fails verification.
const splitAgent: RunConnectFn = async () => ({
  ctx: {
    async open(cwd: string) {
      const title = cwd.endsWith("claude") ? "Skill(qa)" : "Bash(ls)";
      return {
        async setMode() {},
        async prompt(_t: string, _d?: (c: string) => void, onToolCall?: (t: ToolInvocation) => void) {
          const tool = { toolCallId: "t1", title, status: "completed" };
          onToolCall?.(tool);
          return { text: "done", toolCalls: [tool] };
        },
        dispose() {},
      };
    },
  },
  close() {},
});

describe("verifyGemAcrossAgents", () => {
  it("returns one verdict per roster agent in order, isolates dirs, ledgers each run", async () => {
    const home = mkdtempSync(join(tmpdir(), "agem-mx-"));
    const baseDir = join(home, "matrix");
    try {
      const seen: string[] = [];
      const verdicts = await verifyGemAcrossAgents({
        gem, baseDir, home,
        roster: ["claude", "codex"],
        connectFn: splitAgent,
        onVerdict: (v) => seen.push(`${v.agent}:${v.status}`),
      });
      expect(verdicts.map((v) => `${v.agent}:${v.status}`)).toEqual(["claude:passed", "codex:failed"]);
      expect(seen).toEqual(["claude:passed", "codex:failed"]);
      expect(verdicts[0].verification?.passed).toBe(true);
      expect(verdicts[1].verification?.passed).toBe(false);
      // per-agent isolation: both dirs materialized, distinct
      expect(existsSync(join(baseDir, "claude", ".claude", "skills", "qa", "SKILL.md"))).toBe(true);
      expect(existsSync(join(baseDir, "codex"))).toBe(true);
      // ledger: exactly two records, contractApplied, digest present
      const lines = readFileSync(ledgerPath(home), "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const recs = lines.map((l) => JSON.parse(l));
      expect(recs.map((r) => r.agent)).toEqual(["claude", "codex"]);
      expect(recs.every((r) => r.contractApplied === true)).toBe(true);
      expect(recs.every((r) => typeof r.gemDigest === "string" && r.gemDigest.length > 0)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports unavailable (no dir, no ledger row) when the adapter can't resolve and fetch is off", async () => {
    const home = mkdtempSync(join(tmpdir(), "agem-mx-"));
    const baseDir = join(home, "matrix");
    try {
      const verdicts = await verifyGemAcrossAgents({
        gem, baseDir, home,
        roster: ["codex"],
        resolveAdapter: async (a, o) => {
          if (o?.allowFetch === false) throw new Error(`${a.name} adapter (${a.pkg}) is not installed and on-demand fetch is disabled`);
          return [a.bin];
        },
      });
      expect(verdicts).toEqual([
        { agent: "codex", status: "unavailable", detail: expect.stringContaining("not installed") },
      ]);
      expect(existsSync(join(baseDir, "codex"))).toBe(false);
      expect(existsSync(ledgerPath(home))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws InvalidInputError before any run when no contract exists anywhere", async () => {
    const bare: Gem = { ...gem, contract: undefined };
    await expect(verifyGemAcrossAgents({ gem: bare, baseDir: "/tmp/never", connectFn: splitAgent }))
      .rejects.toThrow(/contract/i);
  });

  it("an explicit contract argument overrides the gem's own", async () => {
    const home = mkdtempSync(join(tmpdir(), "agem-mx-"));
    try {
      const verdicts = await verifyGemAcrossAgents({
        gem, baseDir: join(home, "m"), home,
        roster: ["claude"],
        connectFn: splitAgent,
        contract: { task: "t", expect: { tools: ["never-invoked"] } },
      });
      expect(verdicts[0].status).toBe("failed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("deriveMatrixBaseDir", () => {
  it("sanitizes the name and stays inside the runs root", () => {
    const home = "/tmp/agem-home";
    expect(deriveMatrixBaseDir("my gem!", home)).toBe(join(home, ".agentgem", "runs", "my-gem--matrix"));
    expect(deriveMatrixBaseDir("..", home)).toBe(join(home, ".agentgem", "runs", "gem-matrix"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/verifyMatrix.test.js`
Expected: FAIL at compile — `@agentgem/run` does not export `verifyGemAcrossAgents`/`deriveMatrixBaseDir`.

- [ ] **Step 3: Implement the orchestrator**

Create `packages/run/src/verifyMatrix.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The cross-agent verification matrix: run one Gem, against its own contract,
// across the local ACP adapter roster — each agent in a fresh dir — and return a
// deterministic per-agent verdict list. Aggregation is judging, never synthesis:
// the verdict list IS the matrix. Failures are data (a per-agent problem becomes
// a verdict, not an exception); only a missing contract throws, before any run.
import { join, resolve, sep } from "node:path";
import type { Gem, GemContract } from "@agentgem/model";
import { InvalidInputError, agentgemHome } from "@agentgem/model";
import { readGemMeta, writeGemArchive } from "@agentgem/archive";
import { AGENT_ADAPTERS, resolveOrFetchAdapter, materializeAndRunGem, type AgentId } from "./runGem.js";
import { hasTestConnectFn, type RunConnectFn } from "./acpRun.js";
import { contractToExpectations, type VerificationReport } from "./gemVerify.js";
import { appendVerification } from "./evidenceLedger.js";

export interface AgentVerdict {
  agent: AgentId;
  status: "passed" | "failed" | "unavailable";
  verification?: VerificationReport;   // present for passed/failed
  detail?: string;                     // adapter-resolve error or run error
}

export interface VerifyMatrixOptions {
  gem: Gem;
  baseDir: string;                     // caller-derived (deriveMatrixBaseDir); agent id appended per run
  contract?: GemContract;              // default gem.contract; neither → InvalidInputError
  roster?: AgentId[];                  // default: every AGENT_ADAPTERS key
  fetch?: boolean;                     // default false: missing adapter → "unavailable"
  onVerdict?: (v: AgentVerdict) => void;
  connectFn?: RunConnectFn;            // test seam → skips availability, passed to materializeAndRunGem
  resolveAdapter?: typeof resolveOrFetchAdapter; // test seam for hermetic "unavailable"
  home?: string;                       // ledger home (test seam; default agentgemHome())
}

// Shared hardened base-dir derivation for the matrix (endpoint + CLI use the same
// sanitizer). Mirrors gem.controller's deriveRunDir: one path segment, '..' can't
// escape the runs root.
export function deriveMatrixBaseDir(gemName: string, home?: string): string {
  let safeName = gemName.replace(/[^A-Za-z0-9._-]/g, "-");
  if (safeName === "" || safeName === "." || safeName === "..") safeName = "gem";
  const runsRoot = resolve(home ?? agentgemHome(), ".agentgem", "runs");
  const baseDir = resolve(runsRoot, `${safeName}-matrix`);
  if (!baseDir.startsWith(runsRoot + sep)) throw new Error("derived matrix dir escaped the runs root");
  return baseDir;
}

export async function verifyGemAcrossAgents(opts: VerifyMatrixOptions): Promise<AgentVerdict[]> {
  const contract = opts.contract ?? opts.gem.contract;
  if (!contract) throw new InvalidInputError("this Gem carries no contract — the matrix verifies a Gem's own claim");
  const roster = opts.roster ?? (Object.keys(AGENT_ADAPTERS) as AgentId[]);
  const resolveAdapter = opts.resolveAdapter ?? resolveOrFetchAdapter;
  const expectations = contractToExpectations(contract);
  const gemDigest = readGemMeta(writeGemArchive(opts.gem).files).gemDigest;

  const verdicts: AgentVerdict[] = [];
  for (const agent of roster) {
    const adapter = AGENT_ADAPTERS[agent];
    // Availability BEFORE materialize: an unavailable agent must leave no run dir
    // behind. Skipped when a connectFn seam is injected (fakes never spawn).
    if (!opts.connectFn && !hasTestConnectFn()) {
      try {
        await resolveAdapter(adapter, { allowFetch: opts.fetch ?? false });
      } catch (err) {
        const v: AgentVerdict = { agent, status: "unavailable", detail: (err as Error).message };
        verdicts.push(v);
        opts.onVerdict?.(v);
        continue;
      }
    }
    const out = await materializeAndRunGem({
      gem: opts.gem,
      dir: join(opts.baseDir, agent),  // AgentId is a safe literal ("claude" | "codex")
      task: contract.task,
      agent,
      expectations,
      connectFn: opts.connectFn,
      allowFetch: opts.fetch ?? false,
    });
    const verification = out.verification as VerificationReport; // expectations always set → always present
    appendVerification({
      gemName: opts.gem.name,
      gemDigest,
      agent,
      adapterVersion: adapter.version,
      contractApplied: true,
      run: { ok: out.run.ok, toolCalls: out.run.ok ? out.run.result.toolCalls.length : 0 },
      verification,
    }, opts.home);
    const v: AgentVerdict = {
      agent,
      status: verification.passed ? "passed" : "failed",
      verification,
      ...(out.run.ok ? {} : { detail: out.run.error }),
    };
    verdicts.push(v);
    opts.onVerdict?.(v);
  }
  return verdicts;
}
```

Add to `packages/run/src/index.ts` alongside the existing star-exports:

```ts
export * from "./verifyMatrix.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/verifyMatrix.test.js`
Expected: PASS (6 tests). If the first test's codex-dir assertion fails because codex's flavor materializes elsewhere, assert `existsSync(join(baseDir, "codex", ".agents"))` instead — the codex testbed flavor writes `.agents/skills/`.

- [ ] **Step 5: Commit**

```bash
git add packages/run/src/verifyMatrix.ts packages/run/src/index.ts src/gem/__tests__/verifyMatrix.test.ts
git commit -m "feat(run): verifyGemAcrossAgents — cross-agent verification matrix core"
```

---

### Task 2: `POST /api/gem/verify` endpoint

**Files:**
- Modify: `src/schemas.ts` (add `AgentVerdictSchema`, `GemVerifyRequestSchema`, `GemVerifyResponseSchema` near the existing `GemRun*` schemas at ~line 646)
- Modify: `src/gem.controller.ts` (new `@post("/gem/verify")` method next to `runGem` at ~line 846; extend the `@agentgem/run` imports)
- Test: `src/__tests__/gem.controller.test.ts` (extend)

**Interfaces:**
- Consumes: `verifyGemAcrossAgents`, `deriveMatrixBaseDir`, `AgentVerdict`, `AgentId` from `@agentgem/run` (Task 1); existing controller helpers `readArchiveDir`, `readGemArchive`, `readGemMeta`, `writeGemArchive`, `buildGem`, `introspectAll`, `resolveDirs`, `InvalidInputError`, `AGENT_ADAPTERS`; existing `VerificationReportSchema` in schemas.ts.
- Produces: `POST /api/gem/verify` accepting `{ selection?|archivePath?, name?, dir?, projects?, agents?: string[], fetch?: boolean }`, returning `{ gemName, gemDigest, baseDir, verdicts }`. Task 3's CLI does NOT use this endpoint (it calls the core directly).

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/gem.controller.test.ts` inside the existing `describe("POST /api/gem/run", ...)` block (reuses `gem`, `fakeRun`, `agentgemHomeDir`; `setRunConnectFnForTests` makes `hasTestConnectFn()` true so availability is skipped):

```ts
  it("POST /api/gem/verify returns a per-agent matrix for a contract-bearing archive", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    const withContract: Gem = { ...gem, contract: { task: "exercise qa", expect: { tools: ["qa"] } } };
    writeArchiveDir(archiveDir, writeGemArchive(withContract).files);
    setRunConnectFnForTests(fakeRun); // fake invokes "Skill(qa)" → passes for every agent
    try {
      const r = await client.post("/api/gem/verify").send({ archivePath: archiveDir, agents: ["claude", "codex"] }).expect(200);
      expect(r.body.gemName).toBe("qa-gem");
      expect(r.body.gemDigest).toMatch(/./);
      expect(r.body.verdicts.map((v: { agent: string; status: string }) => `${v.agent}:${v.status}`))
        .toEqual(["claude:passed", "codex:passed"]);
    } finally {
      setRunConnectFnForTests(null);
      rmSync(archiveDir, { recursive: true, force: true });
      rmSync(join(agentgemHomeDir, ".agentgem", "runs", "qa-gem-matrix"), { recursive: true, force: true });
    }
  });

  it("POST /api/gem/verify 400s on an unknown agent id and on a contract-less gem", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    writeArchiveDir(archiveDir, writeGemArchive(gem).files); // no contract
    try {
      const contractless = await client.post("/api/gem/verify").send({ archivePath: archiveDir });
      expect(contractless.status).toBe(400);
      const withContract: Gem = { ...gem, contract: { task: "t", expect: {} } };
      writeArchiveDir(archiveDir, writeGemArchive(withContract).files);
      const unknown = await client.post("/api/gem/verify").send({ archivePath: archiveDir, agents: ["gemini"] });
      expect(unknown.status).toBe(400);
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js`
Expected: the two new tests FAIL with 404s (route doesn't exist); all pre-existing tests PASS.

- [ ] **Step 3: Add the schemas**

In `src/schemas.ts`, after `GemRunPrepareResponseSchema` (~line 692):

```ts
export const AgentVerdictSchema = z.object({
  agent: z.enum(["claude", "codex"]),
  status: z.enum(["passed", "failed", "unavailable"]),
  verification: VerificationReportSchema.optional(),
  detail: z.string().optional(),
});
export const GemVerifyRequestSchema = z.object({
  selection: GemSelectionSchema.optional(),
  archivePath: z.string().optional(),
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  // Validated in the controller (unknown ids → InvalidInputError 400) so the error
  // is a clear message, not a schema 422, and the list stays extensible.
  agents: z.array(z.string()).optional(),
  fetch: z.boolean().optional(),       // default false: missing adapters report unavailable, never download
}).refine((d) => d.selection !== undefined || d.archivePath !== undefined, {
  message: "provide either selection or archivePath",
});
export const GemVerifyResponseSchema = z.object({
  gemName: z.string(),
  gemDigest: z.string(),
  baseDir: z.string(),
  verdicts: z.array(AgentVerdictSchema),
});
```

- [ ] **Step 4: Add the endpoint**

In `src/gem.controller.ts`: extend the existing `@agentgem/run` import with `verifyGemAcrossAgents, deriveMatrixBaseDir`, import the three new schemas alongside the other schema imports, and add after `prepareGemRun`:

```ts
  // Cross-agent verification matrix: run the Gem against its OWN contract across
  // the local adapter roster, one fresh dir per agent, verdicts + ledger records.
  // Contract-only by design — loose task/expectations overrides live on /gem/run.
  @post("/gem/verify", { body: GemVerifyRequestSchema, response: GemVerifyResponseSchema })
  async verifyGem(input: { body: z.infer<typeof GemVerifyRequestSchema> }): Promise<z.infer<typeof GemVerifyResponseSchema>> {
    const b = input.body;
    const files = b.archivePath ? readArchiveDir(b.archivePath) : undefined;
    const gem: Gem = files
      ? readGemArchive(files)
      : buildGem(introspectAll(b.dir, b.projects), b.selection!, { name: b.name ?? "gem", createdFrom: resolveDirs(b.dir).claudeDir });
    const known = Object.keys(AGENT_ADAPTERS);
    const unknown = (b.agents ?? []).filter((a) => !known.includes(a));
    if (unknown.length) throw new InvalidInputError(`unknown agent(s): ${unknown.join(", ")}. Known: ${known.join(", ")}`);
    const baseDir = deriveMatrixBaseDir(gem.name);
    const verdicts = await verifyGemAcrossAgents({
      gem,
      baseDir,
      roster: b.agents as AgentId[] | undefined,
      fetch: b.fetch,
    });
    const gemDigest = readGemMeta(files ?? writeGemArchive(gem).files).gemDigest;
    return { gemName: gem.name, gemDigest, baseDir, verdicts };
  }
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js dist/gem/__tests__/verifyMatrix.test.js`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(run): POST /api/gem/verify — cross-agent matrix endpoint"
```

---

### Task 3: `agentgem verify` CLI subcommand

**Files:**
- Create: `src/verifyCli.ts`
- Modify: `src/cli.ts` (dispatch branch + help text)
- Test: `src/__tests__/verifyCli.test.ts` (new)

**Interfaces:**
- Consumes: `verifyGemAcrossAgents`, `deriveMatrixBaseDir`, `AgentVerdict`, `AGENT_ADAPTERS`, `AgentId` from `@agentgem/run`; `readArchiveDir` + `readGemArchive` from `@agentgem/archive`; `InvalidInputError` from `@agentgem/model`.
- Produces: `runVerifyCommand(args: string[], deps?: { verify?: typeof verifyGemAcrossAgents; out?: (line: string) => void; err?: (line: string) => void }): Promise<number>` — returns the process exit code (0 = ≥1 agent available and every available agent passed; 1 = a failure or nothing available; 2 = usage/contract error).

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/verifyCli.test.ts`:

```ts
// src/__tests__/verifyCli.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGemArchive, writeArchiveDir } from "@agentgem/archive";
import { runVerifyCommand } from "../verifyCli.js";
import type { Gem } from "@agentgem/model";
import type { AgentVerdict } from "@agentgem/run";

function archiveWith(contract: boolean): string {
  const gem: Gem = {
    name: "cli-gem", createdFrom: "test",
    artifacts: [{ type: "skill", name: "qa", source: "standalone", content: "# QA" }],
    checks: [], requiredSecrets: [],
    ...(contract ? { contract: { task: "t", expect: { tools: ["qa"] } } } : {}),
  };
  const dir = mkdtempSync(join(tmpdir(), "gem-cli-"));
  writeArchiveDir(dir, writeGemArchive(gem).files);
  return dir;
}

const verdictsOf = (...vs: AgentVerdict[]) => async () => vs;

describe("agentgem verify", () => {
  it("prints one line per verdict and exits 0 when all available agents pass", async () => {
    const dir = archiveWith(true);
    const lines: string[] = [];
    try {
      const code = await runVerifyCommand([dir], {
        verify: verdictsOf(
          { agent: "claude", status: "passed", verification: { passed: true, checks: [] } },
          { agent: "codex", status: "unavailable", detail: "not installed" },
        ),
        out: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines.some((l) => l.includes("claude") && l.includes("passed"))).toBe(true);
      expect(lines.some((l) => l.includes("codex") && l.includes("unavailable"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("exits 1 when any agent fails, and when no agent is available", async () => {
    const dir = archiveWith(true);
    try {
      expect(await runVerifyCommand([dir], {
        verify: verdictsOf({ agent: "claude", status: "failed", verification: { passed: false, checks: [{ name: "x", passed: false, detail: "d" }] } }),
        out: () => {},
      })).toBe(1);
      expect(await runVerifyCommand([dir], {
        verify: verdictsOf({ agent: "claude", status: "unavailable", detail: "not installed" }),
        out: () => {},
      })).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("exits 2 on usage errors: no archive arg, unknown --agents id, contract-less gem", async () => {
    const errs: string[] = [];
    expect(await runVerifyCommand([], { err: (l) => errs.push(l) })).toBe(2);
    const noContract = archiveWith(false);
    const withContract = archiveWith(true);
    try {
      // No injected verify here: the REAL core throws InvalidInputError for a
      // contract-less gem before touching any adapter, so this stays hermetic.
      expect(await runVerifyCommand([noContract], { err: (l) => errs.push(l) })).toBe(2);
      expect(await runVerifyCommand([withContract, "--agents", "gemini"], { verify: verdictsOf(), err: (l) => errs.push(l) })).toBe(2);
      expect(errs.length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(noContract, { recursive: true, force: true });
      rmSync(withContract, { recursive: true, force: true });
    }
  });

  it("passes --fetch and --agents through to the core", async () => {
    const dir = archiveWith(true);
    let got: { roster?: string[]; fetch?: boolean } = {};
    try {
      await runVerifyCommand([dir, "--agents", "claude", "--fetch"], {
        verify: async (o) => { got = { roster: o.roster, fetch: o.fetch }; return []; },
        out: () => {},
      });
      expect(got).toEqual({ roster: ["claude"], fetch: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/verifyCli.test.js`
Expected: FAIL at compile — `../verifyCli.js` does not exist.

- [ ] **Step 3: Implement the CLI**

Create `src/verifyCli.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/verifyCli.ts — `agentgem verify <archive-dir>`: run the cross-agent
// verification matrix from the terminal, no server needed. Exit codes:
// 0 = ≥1 agent available and every available agent passed; 1 = any failure or
// nothing available; 2 = usage/contract error.
import { readArchiveDir, readGemArchive } from "@agentgem/archive";
import { verifyGemAcrossAgents, deriveMatrixBaseDir, AGENT_ADAPTERS, type AgentId, type AgentVerdict } from "@agentgem/run";
import { InvalidInputError } from "@agentgem/model";

interface VerifyCliDeps {
  verify?: typeof verifyGemAcrossAgents;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function renderVerdict(v: AgentVerdict): string {
  if (v.status === "passed") return `✓ ${v.agent} passed · ${v.verification!.checks.length} check(s)`;
  if (v.status === "failed") {
    const firstFail = v.verification?.checks.find((c) => !c.passed);
    return `✗ ${v.agent} failed — ${firstFail ? `${firstFail.name}: ${firstFail.detail}` : v.detail ?? "run failed"}`;
  }
  return `– ${v.agent} unavailable — ${v.detail ?? "adapter not installed"}`;
}

export async function runVerifyCommand(args: string[], deps: VerifyCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const verify = deps.verify ?? verifyGemAcrossAgents;

  const positional = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--agents");
  const archiveDir = positional[0];
  if (!archiveDir) { err("usage: agentgem verify <archive-dir> [--agents claude,codex] [--fetch]"); return 2; }
  const agentsFlag = args.includes("--agents") ? args[args.indexOf("--agents") + 1] : undefined;
  const fetch = args.includes("--fetch");

  let roster: AgentId[] | undefined;
  if (agentsFlag !== undefined) {
    const known = Object.keys(AGENT_ADAPTERS);
    const ids = agentsFlag.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = ids.filter((a) => !known.includes(a));
    if (!ids.length || unknown.length) { err(`unknown agent(s): ${unknown.join(", ") || "(none given)"}. Known: ${known.join(", ")}`); return 2; }
    roster = ids as AgentId[];
  }

  try {
    const gem = readGemArchive(readArchiveDir(archiveDir));
    // Print via onVerdict as agents finish; an injected test `verify` won't call
    // onVerdict, so print any remainder from the returned list afterwards.
    let printed = 0;
    const verdicts = await verify({
      gem,
      baseDir: deriveMatrixBaseDir(gem.name),
      roster,
      fetch,
      onVerdict: (v) => { printed++; out(renderVerdict(v)); },
    });
    for (const v of verdicts.slice(printed)) out(renderVerdict(v));
    const available = verdicts.filter((v) => v.status !== "unavailable");
    const allPassed = available.length > 0 && available.every((v) => v.status === "passed");
    out(`${available.filter((v) => v.status === "passed").length}/${available.length} available agent(s) passed` +
        (verdicts.length !== available.length ? ` · ${verdicts.length - available.length} unavailable` : ""));
    return allPassed ? 0 : 1;
  } catch (e) {
    if (e instanceof InvalidInputError) { err(e.message); return 2; }
    err((e as Error).message);
    return 2;
  }
}
```

(The `printed` counter is load-bearing: live runs print via `onVerdict` as agents finish; an injected test `verify` never calls `onVerdict`, so the post-await loop prints the remainder without double-printing live output.)

- [ ] **Step 4: Wire into `src/cli.ts`**

After the `warm` branch (~line 78), add:

```ts
  // `agentgem verify <archive-dir>` — run the Gem's contract across the local
  // agent roster and print the compatibility matrix.
  if (argv[0] === "verify") {
    const { runVerifyCommand } = await import("./verifyCli.js");
    process.exitCode = await runVerifyCommand(argv.slice(1));
    return;
  }
```

And add to the HELP text's command list (matching its style):

```
  agentgem verify <archive-dir>         Verify a .gem archive across local agents (--agents claude,codex; --fetch)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/verifyCli.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/verifyCli.ts src/cli.ts src/__tests__/verifyCli.test.ts
git commit -m "feat(cli): agentgem verify — cross-agent matrix from the terminal"
```

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Build everything (console assets included), then full root suite**

Run: `pnpm build && pnpm test`
Expected: all green (~1370+ tests). Known flake policy: `observeScan`/`scorecard`/`observe.controller` real-FS tests can time out under full-suite concurrency — re-run in isolation before blaming the change.

- [ ] **Step 2: Console tests + typecheck (not in CI — required locally)**

Run: `pnpm --dir packages/console test && pnpm --dir packages/console exec tsc --noEmit`
Expected: all green; no console code changed.

- [ ] **Step 3: Live CLI smoke (optional but cheap)**

Run: `node dist/cli.js verify --help 2>&1 | head -2 || node dist/cli.js verify`
Expected: the usage line, exit code 2 — proves the dispatch wiring without running a real agent.

- [ ] **Step 4: Branch state**

```bash
git status --short   # expect empty (never commit .superpowers/)
git log --oneline origin/main..HEAD   # spec + 3 code commits
```

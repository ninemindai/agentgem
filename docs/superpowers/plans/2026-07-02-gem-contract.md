# GemContract + Evidence Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Gem carry its own machine-checkable completion contract from build → archive → run, and record every verified run in a local JSONL evidence ledger.

**Architecture:** Add an optional `contract` to the `Gem` model and archive manifest (derived at `buildGem` time for skill-bearing Gems); thread it through the opaque run registry to both run endpoints, where it supplies default verification expectations (explicit query/body params still win); append a best-effort JSONL record under `agentgemHome()` whenever verification runs. Spec: `docs/superpowers/specs/2026-07-02-gem-contract-design.md`.

**Tech Stack:** TypeScript ESM monorepo (pnpm workspaces), vitest (tests compile to `dist/` first: `tsc -b && vitest run`), supertest for controller tests, Zod schemas in `src/schemas.ts`.

## Global Constraints

- Working dir: the `../agentgem-gem-contract` worktree, branch `gem-contract`.
- `ARCHIVE_FORMAT_VERSION` stays `1` — the new manifest field is optional; no version bump.
- Ledger writes are best-effort: an IO failure logs to stderr and must never fail a run response.
- No console (`packages/console`) code changes in this slice.
- Run a single test file with: `pnpm exec tsc -b && pnpm exec vitest run dist/<path>.test.js` (tests execute from compiled `dist/`).
- Commit after every task; messages follow the repo's `feat(scope):` / `test(scope):` convention.
- Node built-ins only; no new dependencies.

---

### Task 1: `GemContract` type + derivation in `buildGem`

**Files:**
- Modify: `packages/model/src/types.ts` (Gem interface is at ~line 170)
- Modify: `packages/build/src/buildGem.ts` (`buildGem` at ~line 44, its `return` at ~line 124)
- Test: `src/gem/__tests__/contract.build.test.ts` (new)

**Interfaces:**
- Consumes: existing `Gem`, `ConfigInventory`, `GemArtifact` from `@agentgem/model`; `buildGem(inventory, selection, opts)` from `@agentgem/build`.
- Produces: `GemContract` interface exported from `@agentgem/model` (via its existing `export * from "./types.js"`); `Gem.contract?: GemContract`; `buildGem` opts gain `contract?: GemContract`; derived default for skill-bearing Gems. Tasks 2–6 import `GemContract` from `@agentgem/model`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/contract.build.test.ts`:

```ts
// src/gem/__tests__/contract.build.test.ts
import { describe, it, expect } from "vitest";
import { buildGem } from "@agentgem/build";
import type { ConfigInventory, GemContract } from "@agentgem/model";

const inv: ConfigInventory = {
  skills: [{ type: "skill", name: "demo-skill", source: "standalone", content: "# demo" }],
  mcpServers: [],
  instructions: [{ type: "instructions", name: "CLAUDE.md", content: "notes" }],
  hooks: [],
};

describe("buildGem contract derivation", () => {
  it("derives a conservative contract when the gem bundles a skill", () => {
    const gem = buildGem(inv, { skills: ["demo-skill"] }, { name: "g" });
    expect(gem.contract).toBeDefined();
    expect(gem.contract!.task).toContain('"demo-skill"');
    expect(gem.contract!.expect.tools).toEqual(["demo-skill"]);
    expect(gem.contract!.expect.forbidToolFailures).toBe(true);
  });

  it("derives no contract for a gem without skills", () => {
    const gem = buildGem(inv, { includeInstructions: true }, { name: "g" });
    expect(gem.contract).toBeUndefined();
  });

  it("an explicit opts.contract wins over derivation", () => {
    const explicit: GemContract = { task: "custom task", expect: { text: "ok" } };
    const gem = buildGem(inv, { skills: ["demo-skill"] }, { name: "g", contract: explicit });
    expect(gem.contract).toEqual(explicit);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/contract.build.test.js`
Expected: FAIL at compile — `GemContract` is not exported by `@agentgem/model` (and `contract` is not a known buildGem option).

- [ ] **Step 3: Add the type and the derivation**

In `packages/model/src/types.ts`, directly above `export interface Gem {`:

```ts
// A Gem's portable completion contract: the task a runner should hand an agent to
// exercise the Gem, and the behavior evidence that proves it worked. String-only
// (no RegExp) so it serializes into the archive manifest verbatim.
export interface GemContract {
  task: string;
  expect: {
    tools?: string[];              // each must substring-match an invoked tool title
    text?: string;                 // substring the agent's output must contain
    forbidToolFailures?: boolean;  // default true at verification time
  };
}
```

Inside `export interface Gem {`, after the `grade?` line:

```ts
  contract?: GemContract;                // portable completion contract; absent = not contract-bearing
```

In `packages/build/src/buildGem.ts`, add `GemContract` to the type-only import from `@agentgem/model`, add `contract?: GemContract;` to the `opts` object type in the `buildGem` signature, and add above `buildGem`:

```ts
// Derive a conservative default contract: only when the gem bundles a skill, whose
// name agents invoke as a tool title (proven by the runner's live validation). Gems
// without skills get no guessed contract — a wrong contract is worse than none.
function deriveContract(artifacts: GemArtifact[]): GemContract | undefined {
  const skill = artifacts.find((a) => a.type === "skill");
  if (!skill) return undefined;
  return {
    task: `Use the "${skill.name}" skill to complete a small demonstration task in this workspace.`,
    expect: { tools: [skill.name], forbidToolFailures: true },
  };
}
```

Change the `return` statement's object to include the contract (explicit opts win):

```ts
  const contract = opts.contract ?? deriveContract(artifacts);

  return {
    name: opts.name ?? "gem",
    createdFrom: opts.createdFrom ?? "unknown",
    artifacts,
    checks,
    requiredSecrets,
    ...(opts.grade != null ? { grade: opts.grade } : {}),
    ...(contract ? { contract } : {}),
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/contract.build.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/types.ts packages/build/src/buildGem.ts src/gem/__tests__/contract.build.test.ts
git commit -m "feat(model,build): GemContract type + derived default contract for skill-bearing gems"
```

---

### Task 2: Contract survives the archive round-trip

**Files:**
- Modify: `packages/archive/src/archive.ts` (`GemManifest` at ~line 71, `writeGemArchive`'s manifest literal at ~line 143, `readGemArchive`'s final `gem` assembly at ~line 216)
- Test: `src/gem/__tests__/contract.archive.test.ts` (new)

**Interfaces:**
- Consumes: `GemContract` from `@agentgem/model` (Task 1); existing `writeGemArchive`, `readGemArchive`, `computeLock`, `GemManifest`.
- Produces: `GemManifest.contract?: GemContract`; `readGemArchive` restores a valid contract onto `Gem.contract` and silently drops a malformed one. Tasks 5–6 rely on archive-read Gems carrying `.contract`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/contract.archive.test.ts`. Note the malformed-contract case must recompute `gem.lock` after tampering with the manifest, or `readGemArchive` fails lock verification before it ever sees the contract:

```ts
// src/gem/__tests__/contract.archive.test.ts
import { describe, it, expect } from "vitest";
import { writeGemArchive, readGemArchive, computeLock } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

const base: Gem = {
  name: "c-gem",
  createdFrom: "test",
  artifacts: [{ type: "skill", name: "qa", source: "standalone", content: "# QA" }],
  checks: [],
  requiredSecrets: [],
};

describe("archive round-trip of the contract", () => {
  it("preserves a contract through write → read", () => {
    const gem: Gem = { ...base, contract: { task: "run qa", expect: { tools: ["qa"], forbidToolFailures: true } } };
    const { files } = writeGemArchive(gem);
    expect(JSON.parse(files["gem.json"]).contract.task).toBe("run qa");
    expect(readGemArchive(files).contract).toEqual(gem.contract);
  });

  it("a gem without a contract reads back without one", () => {
    const { files } = writeGemArchive(base);
    expect("contract" in JSON.parse(files["gem.json"])).toBe(false);
    expect(readGemArchive(files).contract).toBeUndefined();
  });

  it("treats a malformed manifest contract as absent (tolerant reader)", () => {
    const { files } = writeGemArchive(base);
    const manifest = JSON.parse(files["gem.json"]);
    manifest.contract = { task: 42, expect: { tools: "not-an-array" } }; // wrong shapes
    files["gem.json"] = JSON.stringify(manifest, null, 2);
    files["gem.lock"] = JSON.stringify(computeLock(files), null, 2); // keep the lock honest
    expect(readGemArchive(files).contract).toBeUndefined();
  });

  it("keeps a valid task but drops only the invalid expect fields", () => {
    const { files } = writeGemArchive(base);
    const manifest = JSON.parse(files["gem.json"]);
    manifest.contract = { task: "ok", expect: { tools: "nope", text: "hello" } };
    files["gem.json"] = JSON.stringify(manifest, null, 2);
    files["gem.lock"] = JSON.stringify(computeLock(files), null, 2);
    expect(readGemArchive(files).contract).toEqual({ task: "ok", expect: { text: "hello" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/contract.archive.test.js`
Expected: FAIL — first test's `files["gem.json"]` has no `contract` key (write path doesn't serialize it yet).

- [ ] **Step 3: Implement serialization + tolerant read**

In `packages/archive/src/archive.ts`: add `GemContract` to the type-only `@agentgem/model` import. Add to `interface GemManifest` (after `grade?: number;`):

```ts
  contract?: GemContract;
```

In `writeGemArchive`'s `const manifest: GemManifest = {` literal, after the `grade` spread line:

```ts
    ...(gem.contract ? { contract: gem.contract } : {}),
```

Above `readGemArchive`, add:

```ts
// Tolerant contract reader: a hand-edited or future-format manifest must never make
// an archive unreadable. Wrong-shaped fields are dropped; a missing/invalid task
// invalidates the whole contract (there is nothing to run without one).
function sanitizeContract(raw: unknown): GemContract | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const c = raw as { task?: unknown; expect?: unknown };
  if (typeof c.task !== "string" || c.task === "") return undefined;
  const e = (typeof c.expect === "object" && c.expect !== null ? c.expect : {}) as Record<string, unknown>;
  const expect: GemContract["expect"] = {};
  if (Array.isArray(e.tools) && e.tools.every((t) => typeof t === "string")) expect.tools = e.tools as string[];
  if (typeof e.text === "string") expect.text = e.text;
  if (typeof e.forbidToolFailures === "boolean") expect.forbidToolFailures = e.forbidToolFailures;
  return { task: c.task, expect };
}
```

In `readGemArchive`, after the `if (manifest.grade != null) gem.grade = manifest.grade;` line:

```ts
  const contract = sanitizeContract(manifest.contract);
  if (contract) gem.contract = contract;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/contract.archive.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the existing archive tests to catch regressions**

Run: `pnpm exec vitest run dist/gem/__tests__/ --reporter=dot 2>&1 | tail -5`
Expected: all pass (no existing archive fixture asserts an exact manifest key set; if one does, it fails here and the assertion gets the optional key added).

- [ ] **Step 6: Commit**

```bash
git add packages/archive/src/archive.ts src/gem/__tests__/contract.archive.test.ts
git commit -m "feat(archive): serialize GemContract in the manifest; tolerant read"
```

---

### Task 3: Evidence ledger module

**Files:**
- Create: `packages/run/src/evidenceLedger.ts`
- Modify: `packages/run/src/index.ts` (add `export * from "./evidenceLedger.js";`)
- Test: `src/gem/__tests__/evidenceLedger.test.ts` (new)

**Interfaces:**
- Consumes: `agentgemHome()` from `@agentgem/model` (respects `AGENTGEM_HOME` env at call time); `VerificationReport` from `./gemVerify.js`.
- Produces: `appendVerification(rec: Omit<VerificationRecord, "ts">, home?: string): void` and `ledgerPath(home?: string): string`, exported from `@agentgem/run`. Tasks 5–6 call `appendVerification` with no `home` argument (env-isolated in tests via `AGENTGEM_HOME`).

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/evidenceLedger.test.ts`:

```ts
// src/gem/__tests__/evidenceLedger.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendVerification, ledgerPath } from "@agentgem/run";

const rec = {
  gemName: "g",
  gemDigest: "sha256:abc",
  agent: "claude",
  adapterVersion: "0.51.0",
  contractApplied: true,
  run: { ok: true, toolCalls: 2 },
  verification: { passed: true, checks: [{ name: "no tool failures", passed: true, detail: "all tools ok" }] },
};

describe("evidence ledger", () => {
  it("appends one parseable JSONL record per call, stamping ts", () => {
    const home = mkdtempSync(join(tmpdir(), "agem-ledger-"));
    try {
      appendVerification(rec, home);
      appendVerification({ ...rec, contractApplied: false }, home);
      const lines = readFileSync(ledgerPath(home), "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]);
      expect(first.gemName).toBe("g");
      expect(first.verification.passed).toBe(true);
      expect(new Date(first.ts).getTime()).toBeGreaterThan(0); // valid ISO timestamp
      expect(JSON.parse(lines[1]).contractApplied).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never throws when the ledger is unwritable (best-effort)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agem-ledger-"));
    const fileAsHome = join(dir, "not-a-dir");
    writeFileSync(fileAsHome, "occupied"); // home path is a FILE → appendFile fails
    try {
      expect(() => appendVerification(rec, fileAsHome)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/evidenceLedger.test.js`
Expected: FAIL at compile — `@agentgem/run` does not export `appendVerification`.

- [ ] **Step 3: Implement the ledger**

Create `packages/run/src/evidenceLedger.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The local verification-evidence ledger: one JSONL line per verified Gem run,
// under AGENTGEM_HOME. Append-only, local-only (nothing uploads it), best-effort —
// this is an observability substrate for the cross-agent matrix and the journey
// timeline, never a gate: an IO failure must not fail the run that produced it.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { VerificationReport } from "./gemVerify.js";

export interface VerificationRecord {
  ts: string;                          // ISO timestamp, stamped at append
  gemName?: string;
  gemDigest?: string;                  // lock digest — verdicts key on content, not name
  agent: string;
  adapterVersion?: string;
  contractApplied: boolean;            // expectations came from the Gem's contract, not the caller
  run: { ok: boolean; toolCalls: number };
  verification: VerificationReport;
}

export function ledgerPath(home?: string): string {
  return join(home ?? agentgemHome(), "verifications.jsonl");
}

export function appendVerification(rec: Omit<VerificationRecord, "ts">, home?: string): void {
  try {
    const dir = home ?? agentgemHome();
    mkdirSync(dir, { recursive: true });
    const full: VerificationRecord = { ts: new Date().toISOString(), ...rec };
    appendFileSync(ledgerPath(home), JSON.stringify(full) + "\n", "utf8");
  } catch (err) {
    console.error(`[agentgem] evidence-ledger append failed: ${(err as Error).message}`);
  }
}
```

Add to `packages/run/src/index.ts` alongside the existing star-exports:

```ts
export * from "./evidenceLedger.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/evidenceLedger.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/run/src/evidenceLedger.ts packages/run/src/index.ts src/gem/__tests__/evidenceLedger.test.ts
git commit -m "feat(run): verification-evidence ledger (best-effort JSONL under AGENTGEM_HOME)"
```

---

### Task 4: Run-registry meta + `contractToExpectations`

**Files:**
- Modify: `packages/run/src/runGem.ts` (`RUN_REGISTRY`/`registerRun`/`resolveRun` at ~lines 39–48)
- Modify: `packages/run/src/gemVerify.ts` (append the helper)
- Test: `src/gem/__tests__/contract.registry.test.ts` (new)

**Interfaces:**
- Consumes: `GemContract` from `@agentgem/model`; existing `GemExpectations` in `gemVerify.ts`.
- Produces: `interface RunMeta { gemName?: string; gemDigest?: string; contract?: GemContract }` (exported from `runGem.ts`); `registerRun(dir, agent, meta?)`; `resolveRun(id)` now returns `{ dir, agent, meta? }`; `contractToExpectations(c: GemContract): GemExpectations` exported from `gemVerify.ts`. Task 5 reads `resolveRun(...).meta`; Tasks 5–6 call `contractToExpectations`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/contract.registry.test.ts`:

```ts
// src/gem/__tests__/contract.registry.test.ts
import { describe, it, expect } from "vitest";
import { registerRun, resolveRun, contractToExpectations } from "@agentgem/run";
import type { GemContract } from "@agentgem/model";

describe("run-registry meta", () => {
  it("round-trips gem meta through registerRun → resolveRun", () => {
    const contract: GemContract = { task: "t", expect: { tools: ["qa"] } };
    const id = registerRun("/tmp/x", "claude", { gemName: "g", gemDigest: "sha256:d", contract });
    const reg = resolveRun(id);
    expect(reg?.meta?.gemName).toBe("g");
    expect(reg?.meta?.gemDigest).toBe("sha256:d");
    expect(reg?.meta?.contract).toEqual(contract);
  });

  it("meta stays optional — bare registration still resolves", () => {
    const id = registerRun("/tmp/y", "codex");
    expect(resolveRun(id)).toEqual({ dir: "/tmp/y", agent: "codex" });
  });
});

describe("contractToExpectations", () => {
  it("maps every contract field onto GemExpectations", () => {
    expect(contractToExpectations({ task: "t", expect: { tools: ["a"], text: "ok", forbidToolFailures: false } }))
      .toEqual({ expectTools: ["a"], expectText: "ok", forbidToolFailures: false });
  });

  it("omits absent fields so verifyGemRun's defaults apply", () => {
    expect(contractToExpectations({ task: "t", expect: {} })).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/contract.registry.test.js`
Expected: FAIL at compile — `registerRun` takes 2 arguments; `contractToExpectations` not exported.

- [ ] **Step 3: Implement**

In `packages/run/src/runGem.ts`, add `GemContract` to the type-only `@agentgem/model` import, then replace the registry block:

```ts
// Gem facts captured at prepare time so the stream endpoint can verify against the
// Gem's own contract and ledger the result — all server-side; the client still only
// ever holds the opaque runId.
export interface RunMeta { gemName?: string; gemDigest?: string; contract?: GemContract }

const RUN_REGISTRY = new Map<string, { dir: string; agent: AgentId; meta?: RunMeta }>();

export function registerRun(dir: string, agent: AgentId, meta?: RunMeta): string {
  const id = randomUUID();
  RUN_REGISTRY.set(id, { dir, agent, ...(meta ? { meta } : {}) });
  return id;
}
export function resolveRun(id: string): { dir: string; agent: AgentId; meta?: RunMeta } | undefined {
  return RUN_REGISTRY.get(id);
}
```

In `packages/run/src/gemVerify.ts`, add at the top: `import type { GemContract } from "@agentgem/model";` and append at the bottom:

```ts
// Bridge a Gem's serialized contract to the runner's expectation shape. Absent
// fields stay absent so verifyGemRun's own defaults (forbidToolFailures: true) apply.
export function contractToExpectations(c: GemContract): GemExpectations {
  const e: GemExpectations = {};
  if (c.expect.tools !== undefined) e.expectTools = c.expect.tools;
  if (c.expect.text !== undefined) e.expectText = c.expect.text;
  if (c.expect.forbidToolFailures !== undefined) e.forbidToolFailures = c.expect.forbidToolFailures;
  return e;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/contract.registry.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/run/src/runGem.ts packages/run/src/gemVerify.ts src/gem/__tests__/contract.registry.test.ts
git commit -m "feat(run): thread gem meta through the run registry; contract→expectations bridge"
```

---

### Task 5: Prepare threads meta; stream applies the contract and ledgers the verdict

**Files:**
- Modify: `src/gem.controller.ts` (`prepareGemRun` at ~line 860; imports at ~line 156 and ~line 224)
- Modify: `src/gemRunStream.ts` (whole handler is 73 lines)
- Test: `src/__tests__/gemRunStream.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveRun(...).meta`, `contractToExpectations`, `appendVerification`, `ledgerPath`, `AGENT_ADAPTERS` from `@agentgem/run` (Tasks 3–4); `readGemMeta` from `@agentgem/archive`.
- Produces: `prepareGemRun` registers `{ gemName, gemDigest, contract }`; the SSE `done` event gains `contractApplied: boolean`; a `VerificationRecord` is appended whenever verification ran. No response-schema change needed for prepare (meta is server-side only).

- [ ] **Step 1: Extend the stream test — failing first**

In `src/__tests__/gemRunStream.test.ts`, add imports and env isolation. The ledger writes to `agentgemHome()`, so the whole file must point `AGENTGEM_HOME` at a temp dir (the existing first test starts appending too once this task lands):

```ts
import { beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerPath } from "@agentgem/run";
import type { GemContract } from "@agentgem/model";

let home: string;
let prevHome: string | undefined;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "agem-stream-home-"));
  prevHome = process.env.AGENTGEM_HOME;
  process.env.AGENTGEM_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  if (prevHome !== undefined) process.env.AGENTGEM_HOME = prevHome;
  else delete process.env.AGENTGEM_HOME;
});
```

Add these tests inside `describe("streamGemRun", ...)`:

```ts
  it("falls back to the registry contract for task + expectations, flags contractApplied, and ledgers", async () => {
    setRunConnectFnForTests(okAgent);
    const contract: GemContract = { task: "contract task", expect: { tools: ["Write"] } };
    const runId = registerRun("/tmp/prepared-run", "claude", { gemName: "g", gemDigest: "sha256:d", contract });
    const { res, events } = fakeRes();
    await streamGemRun({ query: { runId } }, res); // no task, no expect* params
    const done = events().find((e) => e.event === "done");
    expect(done?.data.verification.passed).toBe(true);
    expect(done?.data.contractApplied).toBe(true);
    const rec = JSON.parse(readFileSync(ledgerPath(), "utf8").trim().split("\n").at(-1)!);
    expect(rec.gemName).toBe("g");
    expect(rec.gemDigest).toBe("sha256:d");
    expect(rec.agent).toBe("claude");
    expect(rec.contractApplied).toBe(true);
    expect(rec.verification.passed).toBe(true);
  });

  it("explicit query expectations replace the contract's entirely", async () => {
    setRunConnectFnForTests(okAgent);
    const contract: GemContract = { task: "contract task", expect: { text: "never-in-output" } };
    const runId = registerRun("/tmp/prepared-run", "claude", { contract });
    const { res, events } = fakeRes();
    await streamGemRun({ query: { runId, expectTools: "Write" } }, res);
    const done = events().find((e) => e.event === "done");
    // Contract's expectText would fail; the query override must have replaced it wholly.
    expect(done?.data.verification.passed).toBe(true);
    expect(done?.data.contractApplied).toBe(false);
  });

  it("still fails on a missing task when the run has no contract", async () => {
    const runId = registerRun("/tmp/prepared-run", "claude");
    const { res, events } = fakeRes();
    await streamGemRun({ query: { runId } }, res);
    const evs = events();
    expect(evs.map((e) => e.event)).toEqual(["failed"]);
    expect(evs[0].data.message).toMatch(/missing task/i);
  });

  it("runs without verification when neither params nor contract exist (no ledger row)", async () => {
    setRunConnectFnForTests(okAgent);
    const before = existsSync(ledgerPath()) ? readFileSync(ledgerPath(), "utf8").trim().split("\n").length : 0;
    const runId = registerRun("/tmp/prepared-run", "claude");
    const { res, events } = fakeRes();
    await streamGemRun({ query: { runId, task: "go" } }, res);
    const done = events().find((e) => e.event === "done");
    expect(done?.data.verification).toBeUndefined();
    expect(done?.data.contractApplied).toBe(false);
    const after = existsSync(ledgerPath()) ? readFileSync(ledgerPath(), "utf8").trim().split("\n").length : 0;
    expect(after).toBe(before);
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gemRunStream.test.js`
Expected: the two existing tests PASS; the four new ones FAIL (missing-task fires because no contract fallback exists; `contractApplied` undefined).

- [ ] **Step 3: Implement the stream changes**

Replace the body of `src/gemRunStream.ts`'s `streamGemRun` logic (keep the SSE header/`send` scaffolding as is). New imports at the top:

```ts
import { contractToExpectations, appendVerification } from "@agentgem/run";
```

Inside the `try`, replace from `const reg = resolveRun(runId);` down to the `send("done", ...)` line with:

```ts
    const reg = resolveRun(runId);
    if (!reg) { send("failed", { message: "unknown or expired runId — prepare the run again" }); return; }
    const contract = reg.meta?.contract;
    const resolvedTask = task || contract?.task || "";
    if (!resolvedTask) { send("failed", { message: "missing task (no task param and the Gem carries no contract)" }); return; }

    // Resolve the adapter (fetching on demand if needed), streaming a phase so a
    // one-time download shows progress instead of a hang.
    const adapter = AGENT_ADAPTERS[reg.agent];
    const command = hasTestConnectFn()
      ? [adapter.bin]
      : await resolveOrFetchAdapter(adapter, {
          onFetch: () => send("phase", { phase: "preparing-adapter", agent: reg.agent, pkg: adapter.pkg }),
        });
    send("phase", { phase: "running", agent: reg.agent });
    const run = await runGemWithAgent({
      dir: reg.dir,
      task: resolvedTask,
      descriptor: { id: adapter.id, name: adapter.name, command },
      onToolCall: (t) => send("tool", t),
      onDelta: (c) => send("delta", { text: c }),
    });
    // Explicit query expectations replace the contract's entirely (no per-field mixing).
    const queryExpectations: GemExpectations | undefined =
      expectTools || expectText ? { expectTools, expectText } : undefined;
    const expectations = queryExpectations ?? (contract ? contractToExpectations(contract) : undefined);
    const contractApplied = queryExpectations === undefined && contract !== undefined;
    const verification = expectations ? verifyGemRun(run, expectations) : undefined;
    if (verification) {
      appendVerification({
        gemName: reg.meta?.gemName,
        gemDigest: reg.meta?.gemDigest,
        agent: reg.agent,
        adapterVersion: adapter.version,
        contractApplied,
        run: { ok: run.ok, toolCalls: run.ok ? run.result.toolCalls.length : 0 },
        verification,
      });
    }
    send("done", { runId, agent: reg.agent, run, verification, contractApplied });
```

(The old `if (!task)` guard above the `try` moves here as the `resolvedTask` check; delete the original.)

- [ ] **Step 4: Thread meta from prepare**

In `src/gem.controller.ts`, extend the `@agentgem/archive` import at ~line 156 with `readGemMeta`, and rewrite `prepareGemRun`:

```ts
  @post("/gem/run/prepare", { body: GemRunPrepareRequestSchema, response: GemRunPrepareResponseSchema })
  async prepareGemRun(input: { body: z.infer<typeof GemRunPrepareRequestSchema> }): Promise<z.infer<typeof GemRunPrepareResponseSchema>> {
    const b = input.body;
    const files = b.archivePath ? readArchiveDir(b.archivePath) : undefined;
    const gem: Gem = files
      ? readGemArchive(files)
      : buildGem(introspectAll(b.dir, b.projects), b.selection!, { name: b.name ?? "gem", createdFrom: resolveDirs(b.dir).claudeDir });
    const agent = (b.agent ?? "claude") as AgentId;
    const runDir = deriveRunDir(gem.name);
    const materialized = materializeGemToTestbed(gem, runDir, AGENT_ADAPTERS[agent].flavor);
    // Capture gem facts server-side so the stream can verify against the Gem's own
    // contract and ledger the verdict under a stable content digest.
    const gemDigest = readGemMeta(files ?? writeGemArchive(gem).files).gemDigest;
    const runId = registerRun(runDir, agent, { gemName: gem.name, gemDigest, contract: gem.contract });
    return { runId, runDir, agent, materialized };
  }
```

- [ ] **Step 5: Run the stream + controller tests**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gemRunStream.test.js dist/__tests__/gem.controller.test.js`
Expected: PASS (all — the existing prepare test's `resolveRun` assertion still matches on `dir`/`agent`; if it asserts deep equality on the whole record, extend it with the new `meta` key).

- [ ] **Step 6: Commit**

```bash
git add src/gemRunStream.ts src/gem.controller.ts src/__tests__/gemRunStream.test.ts
git commit -m "feat(run): stream endpoint verifies against the Gem's contract and ledgers the verdict"
```

---

### Task 6: Blocking `/api/gem/run` honors the contract

**Files:**
- Modify: `src/schemas.ts` (`GemRunRequestSchema` at ~line 655: `task` becomes optional)
- Modify: `src/gem.controller.ts` (`runGem` at ~line 846)
- Test: `src/__tests__/gem.controller.test.ts` (extend the `POST /api/gem/run` describe)

**Interfaces:**
- Consumes: `contractToExpectations`, `appendVerification`, `ledgerPath`, `AGENT_ADAPTERS` (Tasks 3–4); `InvalidInputError` from `@agentgem/model`; archive-read Gems carrying `.contract` (Task 2).
- Produces: `task` optional in `GemRunRequestSchema` (falls back to `contract.task`, 400 when neither); body `expectations` override contract expectations wholly; ledger row on every verified blocking run.

- [ ] **Step 1: Write the failing tests**

Add to the `POST /api/gem/run` describe in `src/__tests__/gem.controller.test.ts` (reuse the existing `gem`, `fakeRun`, and `agentgemHomeDir`; `readFileSync` is already imported — the test reads the ledger file directly since the file already pins `AGENTGEM_HOME` to `agentgemHomeDir`):

```ts
  it("uses the archived contract when no task/expectations are sent, and ledgers", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    const runDir = join(agentgemHomeDir, ".agentgem", "runs", "qa-gem");
    const withContract: Gem = { ...gem, contract: { task: "exercise qa", expect: { tools: ["qa"] } } };
    writeArchiveDir(archiveDir, writeGemArchive(withContract).files);
    setRunConnectFnForTests(fakeRun);
    try {
      const r = await client.post("/api/gem/run").send({ archivePath: archiveDir }).expect(200);
      expect(r.body.verification.passed).toBe(true); // fake invokes "Skill(qa)" → matches "qa"
      const rec = JSON.parse(readFileSync(join(agentgemHomeDir, "verifications.jsonl"), "utf8").trim().split("\n").at(-1)!);
      expect(rec.gemName).toBe("qa-gem");
      expect(rec.contractApplied).toBe(true);
      expect(rec.agent).toBe("claude");
    } finally {
      setRunConnectFnForTests(null);
      rmSync(archiveDir, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("400s when neither a task nor a contract exists", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    writeArchiveDir(archiveDir, writeGemArchive(gem).files); // no contract on `gem`
    const r = await client.post("/api/gem/run").send({ archivePath: archiveDir });
    expect(r.status).toBe(400);
    rmSync(archiveDir, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js`
Expected: new tests FAIL — the first gets a 422 (`task` required by schema), the second a 422 instead of 400.

- [ ] **Step 3: Implement**

In `src/schemas.ts` (`GemRunRequestSchema`), change `task: z.string(),` to:

```ts
  task: z.string().optional(),                             // falls back to the Gem's contract.task
```

In `src/gem.controller.ts`, add `InvalidInputError` to the `@agentgem/model` import and `contractToExpectations, appendVerification` to the `@agentgem/run` import, then rewrite `runGem`:

```ts
  @post("/gem/run", { body: GemRunRequestSchema, response: GemRunResponseSchema })
  async runGem(input: { body: z.infer<typeof GemRunRequestSchema> }): Promise<z.infer<typeof GemRunResponseSchema>> {
    const b = input.body;
    const files = b.archivePath ? readArchiveDir(b.archivePath) : undefined;
    const gem: Gem = files
      ? readGemArchive(files)
      : buildGem(introspectAll(b.dir, b.projects), b.selection!, { name: b.name ?? "gem", createdFrom: resolveDirs(b.dir).claudeDir });
    const task = b.task ?? gem.contract?.task;
    if (!task) throw new InvalidInputError("task is required (this Gem carries no contract)");
    // Explicit body expectations replace the contract's entirely (no per-field mixing).
    const expectations = b.expectations ?? (gem.contract ? contractToExpectations(gem.contract) : undefined);
    const contractApplied = b.expectations === undefined && gem.contract !== undefined;
    const agent = (b.agent ?? "claude") as AgentId;
    const runDir = deriveRunDir(gem.name);
    const out = await materializeAndRunGem({ gem, dir: runDir, task, agent, expectations });
    if (out.verification) {
      appendVerification({
        gemName: gem.name,
        gemDigest: readGemMeta(files ?? writeGemArchive(gem).files).gemDigest,
        agent: out.agent,
        adapterVersion: AGENT_ADAPTERS[out.agent].version,
        contractApplied,
        run: { ok: out.run.ok, toolCalls: out.run.ok ? out.run.result.toolCalls.length : 0 },
        verification: out.verification,
      });
    }
    return { dir: runDir, agent: out.agent, materialized: out.materialized, run: out.run, verification: out.verification };
  }
```

(If `InvalidInputError` doesn't map to a 400 in this app's error handler, check how other controllers throw it — `buildGem` already throws it for bad selections and the existing tests expect 400s from those paths.)

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js`
Expected: PASS (all, including the two pre-existing run tests — they send explicit `task`/`expectations`, so behavior is unchanged for them).

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(run): blocking /gem/run falls back to the Gem contract; ledgers verified runs"
```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full root suite**

Run: `pnpm test`
Expected: all green. Known flake: `observeScan`/`scorecard`/`observe.controller` real-FS tests can time out under full-suite concurrency — if one fails, re-run it in isolation before suspecting this change.

- [ ] **Step 2: Console tests (not in CI — must run locally)**

Run: `pnpm --dir packages/console test && pnpm --dir packages/console exec tsc --noEmit`
Expected: all green, no changes expected (this slice touches no console code, but `contractApplied` on the SSE `done` event is additive and the console types the event loosely).

- [ ] **Step 3: Compat spot-check**

Run: `grep -n "ARCHIVE_FORMAT_VERSION = 1" packages/archive/src/archive.ts`
Expected: unchanged (`= 1`). The manifest field is optional; no format bump per spec.

- [ ] **Step 4: Commit any stragglers and confirm branch state**

```bash
git status --short   # expect empty
git log --oneline origin/main..HEAD   # expect ~6 commits, all this slice
```

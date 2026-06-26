# Sandboxed Gem-Run Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a Gem's local ACP agent inside an OS-native filesystem sandbox scoped to the run dir, so auto-allow can be safe-by-default on the sandboxed path.

**Architecture:** A pluggable `SandboxBackend` registry sits in front of the existing `RunConnectFn` seam. Each backend produces a `RunConnectFn` pre-scoped to a run dir; isolated backends (`macos-seatbelt`, `linux-bubblewrap`) wrap the agent command with a sandbox launcher and run with `permission:"allow"`, while the `child-spawn` fallback stays `deny` (with the existing env escape hatch). `runGemWithAgent` auto-selects the best available backend and reports it in the outcome.

**Tech Stack:** TypeScript (NodeNext ESM), vitest (runs **compiled** tests from `dist/` — always `npx tsc -b` before `npx vitest run`), macOS `sandbox-exec` (seatbelt), Linux `bubblewrap` (`bwrap`).

## Global Constraints

- Tests run from `dist/`: build with `npx tsc -b`, then `npx vitest run dist/<path>.test.js`. After renames/moves, `rm -rf dist *.tsbuildinfo` first.
- Imports use explicit `.js` extensions (NodeNext).
- Commit identity: `Raymond Feng <raymond@ninemind.ai>`; end commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Branch: `issue-4-sandbox` (already created).
- v1 scope: contain **filesystem writes** to the run dir (+ temp). Reads, process-exec, and network stay open. No agentOS, no egress filtering, no Windows isolation.
- Never weaken the unsandboxed path: `child-spawn` stays `permission:"deny"` unless `AGENTGEM_GEM_RUN_AUTOALLOW=1`.

---

### Task 1: Pure sandbox-launcher generators

**Files:**
- Create: `src/gem/sandboxLaunch.ts`
- Test: `src/gem/__tests__/sandboxLaunch.test.ts`

**Interfaces:**
- Produces:
  - `seatbeltPolicy(runDir: string, tmpDir?: string): string`
  - `bwrapArgs(runDir: string, tmpDir?: string): string[]`
  - `wrapWithSandbox(kind: "macos-seatbelt" | "linux-bubblewrap", runDir: string, command: string[]): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/sandboxLaunch.test.ts
import { describe, it, expect } from "vitest";
import { seatbeltPolicy, bwrapArgs, wrapWithSandbox } from "../sandboxLaunch.js";

describe("seatbeltPolicy", () => {
  it("allows by default, denies writes, re-allows writes under runDir + tmp", () => {
    const p = seatbeltPolicy("/runs/g", "/tmp");
    expect(p).toContain("(allow default)");
    expect(p).toContain("(deny file-write*)");
    expect(p).toContain('(subpath "/runs/g")');
    expect(p).toContain('(subpath "/tmp")');
    // write-allow must come AFTER the blanket deny so it wins
    expect(p.indexOf("(deny file-write*)")).toBeLessThan(p.indexOf('(subpath "/runs/g")'));
  });
});

describe("bwrapArgs", () => {
  it("read-only-binds the root and writable-binds only runDir + tmp", () => {
    const a = bwrapArgs("/runs/g", "/tmp");
    expect(a).toEqual(expect.arrayContaining(["--ro-bind", "/", "/"]));
    // writable bind for the run dir
    const i = a.indexOf("--bind");
    expect(a.slice(i, i + 3)).toEqual(["--bind", "/runs/g", "/runs/g"]);
    expect(a).toContain("--die-with-parent");
  });
});

describe("wrapWithSandbox", () => {
  it("prepends sandbox-exec -p <policy> for seatbelt", () => {
    const cmd = wrapWithSandbox("macos-seatbelt", "/runs/g", ["claude-agent-acp", "--x"]);
    expect(cmd[0]).toBe("sandbox-exec");
    expect(cmd[1]).toBe("-p");
    expect(cmd[2]).toContain("(deny file-write*)");
    expect(cmd.slice(3)).toEqual(["claude-agent-acp", "--x"]);
  });

  it("prepends bwrap … -- for bubblewrap", () => {
    const cmd = wrapWithSandbox("linux-bubblewrap", "/runs/g", ["claude-agent-acp"]);
    expect(cmd[0]).toBe("bwrap");
    const sep = cmd.indexOf("--");
    expect(cmd.slice(sep + 1)).toEqual(["claude-agent-acp"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/gem/__tests__/sandboxLaunch.test.js`
Expected: FAIL — `Cannot find module '../sandboxLaunch.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/gem/sandboxLaunch.ts
// Pure generators for the OS-native sandbox launchers. The v1 boundary contains
// FILESYSTEM WRITES to the run dir (+ temp); reads, exec, and network stay open. This
// "write-deny" shape (allow-all, then deny writes, then re-allow under runDir) avoids
// the deny-default trap that kills the agent's own runtime before it can start.
import { tmpdir } from "node:os";

export type SandboxKind = "macos-seatbelt" | "linux-bubblewrap";

export function seatbeltPolicy(runDir: string, tmpDir: string = tmpdir()): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    `  (subpath ${q(runDir)})`,
    `  (subpath ${q(tmpDir)})`,
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")',
    '  (subpath "/dev/tty") (regex #"^/dev/fd/"))',
  ].join("\n");
}

// SBPL string literal: wrap in double quotes (paths under our control have no quotes).
function q(p: string): string { return `"${p}"`; }

export function bwrapArgs(runDir: string, tmpDir: string = tmpdir()): string[] {
  return [
    "--ro-bind", "/", "/",        // everything readable, nothing writable…
    "--bind", runDir, runDir,     // …except the run dir…
    "--bind", tmpDir, tmpDir,     // …and temp.
    "--dev", "/dev",
    "--proc", "/proc",
    "--die-with-parent",
  ];
}

export function wrapWithSandbox(kind: SandboxKind, runDir: string, command: string[]): string[] {
  if (kind === "macos-seatbelt") return ["sandbox-exec", "-p", seatbeltPolicy(runDir), ...command];
  return ["bwrap", ...bwrapArgs(runDir), "--", ...command];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -b && npx vitest run dist/gem/__tests__/sandboxLaunch.test.js`
Expected: PASS (6 assertions across 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/sandboxLaunch.ts src/gem/__tests__/sandboxLaunch.test.ts
git commit -m "feat(sandbox): pure OS-native sandbox-launcher generators (#4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: The real boundary — sandbox-exec actually blocks outside writes (macOS-gated)

This is the security teeth: prove the generated policy confines writes on real hardware.

**Files:**
- Test: `src/gem/__tests__/sandboxLaunch.boundary.test.ts`

**Interfaces:**
- Consumes: `seatbeltPolicy` from Task 1.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/sandboxLaunch.boundary.test.ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatbeltPolicy } from "../sandboxLaunch.js";

const onMac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

// Run `sh -c <script>` under the generated policy; return true if it exited 0.
function runJailed(runDir: string, script: string): boolean {
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", seatbeltPolicy(runDir), "/bin/sh", "-c", script], { stdio: "pipe" });
    return true;
  } catch { return false; }
}

describe.skipIf(!onMac)("seatbelt boundary (macOS)", () => {
  it("denies a write OUTSIDE the run dir but allows one INSIDE", () => {
    const run = mkdtempSync(join(tmpdir(), "sbx-run-"));
    const outside = mkdtempSync(join(tmpdir(), "sbx-out-"));
    try {
      const inside = join(run, "ok.txt");
      const evil = join(outside, "pwned.txt");
      expect(runJailed(run, `echo hi > ${inside}`)).toBe(true);
      expect(readFileSync(inside, "utf8")).toBe("hi\n");
      expect(runJailed(run, `echo bad > ${evil}`)).toBe(false);
      expect(existsSync(evil)).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or skips off-macOS)**

Run: `npx tsc -b && npx vitest run dist/gem/__tests__/sandboxLaunch.boundary.test.js`
Expected on macOS: FAIL only if the policy is wrong; with Task 1's policy it should PASS. On non-macOS: SKIPPED (0 run). NOTE: this test validates Task 1's output — if it fails on macOS, fix `seatbeltPolicy` (e.g. ensure the `tmpdir()` default covers the mkdtemp location, and the write-allow subpath uses the realpath of `run`).

- [ ] **Step 3: (no new impl)** — if it passed, done. If it failed, adjust `seatbeltPolicy` in `sandboxLaunch.ts` until both assertions hold, re-running the command above.

- [ ] **Step 4: Commit**

```bash
git add src/gem/__tests__/sandboxLaunch.boundary.test.ts
git commit -m "test(sandbox): prove seatbelt policy confines writes to the run dir (#4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `SandboxBackend` registry + `selectRunBackend`

**Files:**
- Create: `src/gem/sandbox.ts`
- Test: `src/gem/__tests__/sandbox.test.ts`

**Interfaces:**
- Consumes: `wrapWithSandbox`, `SandboxKind` from Task 1; `connectRunSession` from Task 4 is NOT yet available — so Task 3 defines the backend's `connectFn` to take a **connector** injected at construction to stay testable without spawning. Final wiring uses the real connector in Task 4.
- Produces:
  - `interface SandboxBackend { id: string; isolated: boolean; available(): boolean; connectFn(runDir: string): RunConnectFn }`
  - `const RUN_BACKENDS: SandboxBackend[]` (ordered: isolated first, child-spawn last)
  - `function selectRunBackend(runDir: string, registry?: SandboxBackend[]): { backend: SandboxBackend; connectFn: RunConnectFn }`
  - `function envPermission(env?: NodeJS.ProcessEnv): "allow" | "deny"`  // `AGENTGEM_GEM_RUN_AUTOALLOW==="1" ? "allow" : "deny"`

**Note on module shape:** `sandbox.ts` imports the connect façade `connectRunSession` and types (`RunConnectFn`, `AgentDescriptor`) from `acpRun.ts`; `acpRun.ts` imports `selectRunBackend` from `sandbox.ts`. Both imported names are used only at call time (inside `connectFn`/`runGemWithAgent`), so this value cycle is safe under ESM. Task 4 creates `connectRunSession`; in this task, reference it via `import { connectRunSession } from "./acpRun.js"` — it will exist once Task 4 lands. To keep Task 3 independently testable, the unit tests below use **fake backends**, never the real connector.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/sandbox.test.ts
import { describe, it, expect } from "vitest";
import { selectRunBackend, envPermission, type SandboxBackend } from "../sandbox.js";

const fake = (id: string, isolated: boolean, available: boolean): SandboxBackend => ({
  id, isolated, available: () => available,
  connectFn: () => async () => ({ ctx: { open: async () => ({ setMode: async () => {}, prompt: async () => ({ text: "", toolCalls: [] }), dispose: () => {} }) }, close: () => {} }),
});

describe("selectRunBackend", () => {
  it("prefers the first available isolated backend", () => {
    const reg = [fake("iso-a", true, false), fake("iso-b", true, true), fake("child-spawn", false, true)];
    expect(selectRunBackend("/runs/g", reg).backend.id).toBe("iso-b");
  });

  it("falls back to child-spawn when no isolated backend is available", () => {
    const reg = [fake("iso-a", true, false), fake("child-spawn", false, true)];
    expect(selectRunBackend("/runs/g", reg).backend.id).toBe("child-spawn");
  });
});

describe("envPermission", () => {
  it("is deny by default and allow only when the opt-in flag is set", () => {
    expect(envPermission({})).toBe("deny");
    expect(envPermission({ AGENTGEM_GEM_RUN_AUTOALLOW: "1" })).toBe("allow");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/gem/__tests__/sandbox.test.js`
Expected: FAIL — `Cannot find module '../sandbox.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/gem/sandbox.ts
// Pluggable sandbox-backend registry in front of the RunConnectFn seam. Each backend
// produces a RunConnectFn pre-scoped to a run dir. Auto-allow is capability-gated:
// isolated backends run permission:"allow" (the FS boundary bounds blast radius);
// the child-spawn fallback stays deny unless AGENTGEM_GEM_RUN_AUTOALLOW=1.
import { existsSync } from "node:fs";
import { connectRunSession } from "./acpRun.js";          // value used at call-time (safe ESM cycle)
import type { RunConnectFn, AgentDescriptor } from "./acpRun.js";
import { wrapWithSandbox, type SandboxKind } from "./sandboxLaunch.js";

export interface SandboxBackend {
  id: string;
  isolated: boolean;
  available(): boolean;
  connectFn(runDir: string): RunConnectFn;
}

export function envPermission(env: NodeJS.ProcessEnv = process.env): "allow" | "deny" {
  return env.AGENTGEM_GEM_RUN_AUTOALLOW === "1" ? "allow" : "deny";
}

// An isolated backend: wrap the agent command with the OS sandbox launcher (so the
// agent AND its child shells inherit the jail) and auto-allow tool calls.
function isolatedBackend(id: string, kind: SandboxKind, bin: string, supported: () => boolean): SandboxBackend {
  return {
    id, isolated: true,
    available: () => supported() && existsSync(bin),
    connectFn: (runDir) => (descriptor: AgentDescriptor, app) =>
      connectRunSession({ ...descriptor, command: wrapWithSandbox(kind, runDir, descriptor.command) }, "allow", app),
  };
}

export const childSpawnBackend: SandboxBackend = {
  id: "child-spawn",
  isolated: false,
  available: () => true,
  connectFn: () => (descriptor: AgentDescriptor, app) => connectRunSession(descriptor, envPermission(), app),
};

export const RUN_BACKENDS: SandboxBackend[] = [
  isolatedBackend("macos-seatbelt", "macos-seatbelt", "/usr/bin/sandbox-exec", () => process.platform === "darwin"),
  isolatedBackend("linux-bubblewrap", "linux-bubblewrap", "/usr/bin/bwrap", () => process.platform === "linux"),
  childSpawnBackend,
];

export function selectRunBackend(
  runDir: string,
  registry: SandboxBackend[] = RUN_BACKENDS,
): { backend: SandboxBackend; connectFn: RunConnectFn } {
  const backend = registry.find((b) => b.isolated && b.available()) ?? childSpawnBackend;
  return { backend, connectFn: backend.connectFn(runDir) };
}
```

Note: `bwrap` may live elsewhere on `PATH`; v1 checks `/usr/bin/bwrap`. Linux refinement (PATH lookup) is a follow-up; the macOS path is the one this issue verifies.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -b && npx vitest run dist/gem/__tests__/sandbox.test.js`
Expected: PASS (4 assertions). The `connectRunSession` import resolves once Task 4 lands; if running Task 3 in isolation before Task 4, `tsc -b` will error on the missing export — implement Task 4 Step 3's `connectRunSession` extraction first, then return here. (Subagent-driven execution should run Task 4's refactor and Task 3 together if ordering bites.)

- [ ] **Step 5: Commit**

```bash
git add src/gem/sandbox.ts src/gem/__tests__/sandbox.test.ts
git commit -m "feat(sandbox): SandboxBackend registry + capability-gated selection (#4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire `runGemWithAgent` to the registry + report the sandbox in the outcome

**Files:**
- Modify: `src/gem/acpRun.ts` (extract `connectRunSession`; change `runGemWithAgent`; extend `GemRunOutcome`)
- Test: `src/gem/__tests__/acpRun.test.ts` (add outcome-shape assertion)

**Interfaces:**
- Produces:
  - `function connectRunSession(descriptor: AgentDescriptor, permission: "allow" | "deny", app?: unknown): Promise<{ ctx: RunCtx; close: () => void }>`
  - `GemRunOutcome` gains `sandbox: { backend: string; isolated: boolean }`
- Consumes: `selectRunBackend` from Task 3.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/gem/__tests__/acpRun.test.ts
import { runGemWithAgent, setRunConnectFnForTests } from "../acpRun.js";

it("reports the sandbox backend in the outcome (injected connectFn => not isolated)", async () => {
  setRunConnectFnForTests(async () => ({
    ctx: { open: async () => ({ setMode: async () => {}, prompt: async () => ({ text: "ok", toolCalls: [] }), dispose: () => {} }) },
    close: () => {},
  }));
  try {
    const out = await runGemWithAgent({ dir: "/tmp/whatever", task: "do" });
    expect(out.ok).toBe(true);
    expect(out.sandbox).toEqual({ backend: "injected", isolated: false });
  } finally {
    setRunConnectFnForTests(null);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/gem/__tests__/acpRun.test.js`
Expected: FAIL — `out.sandbox` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `src/gem/acpRun.ts`:

(a) Add `sandbox` to the outcome type:

```ts
export interface GemRunOutcome {
  ok: boolean;
  result: RunResult;
  error?: string;
  sandbox: { backend: string; isolated: boolean };
}
```

(b) Extract the connect façade from `defaultRunConnectFn` into a permission-parameterized function, and re-express `defaultRunConnectFn` in terms of it (kept for back-compat; now deny/allow by env):

```ts
import { connectAcpAdapter } from "./acpSession.js";
import { selectRunBackend } from "./sandbox.js";          // value used at call-time (safe ESM cycle)

// The shared run-session façade: connect the adapter with an explicit permission policy
// and fold each update into a RunResult. Backends in sandbox.ts call this with a wrapped
// descriptor (isolated => "allow") or the raw descriptor (child-spawn => env policy).
export async function connectRunSession(
  descriptor: AgentDescriptor,
  permission: "allow" | "deny",
  _app?: unknown,
): Promise<{ ctx: RunCtx; close: () => void }> {
  const raw = await connectAcpAdapter(descriptor, { clientName: "agentgem-gem-runner", permission });
  const ctx: RunCtx = {
    async open(cwd: string) {
      const session = await raw.open(cwd);
      return {
        setMode: (mode: string) => session.setMode(mode),
        async prompt(text, onDelta, onToolCall) {
          const acc = createAccumulator();
          await session.prompt(text, (u) => applyUpdate(acc, (u ?? {}) as Parameters<typeof applyUpdate>[1], { onDelta, onToolCall }));
          return acc;
        },
        dispose: () => session.dispose(),
      };
    },
  };
  return { ctx, close: raw.close };
}

// Back-compat: the unsandboxed child-spawn connect, env-gated like before.
export const defaultRunConnectFn: RunConnectFn = (descriptor, app) =>
  connectRunSession(descriptor, process.env.AGENTGEM_GEM_RUN_AUTOALLOW === "1" ? "allow" : "deny", app);
```

(c) Rewrite the connect selection + outcome in `runGemWithAgent`:

```ts
export async function runGemWithAgent(opts: RunGemOptions): Promise<GemRunOutcome> {
  const explicit = opts.connectFn ?? testConnectFn;
  const selected = explicit ? null : selectRunBackend(opts.dir);
  const connectFn = explicit ?? selected!.connectFn;
  const sandbox = selected
    ? { backend: selected.backend.id, isolated: selected.backend.isolated }
    : { backend: "injected", isolated: false };
  const mode = opts.mode ?? DEFAULT_RUN_MODE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  let conn: { ctx: RunCtx; close: () => void } | null = null;
  let handle: RunSessionHandle | null = null;
  try {
    conn = await connectFn(opts.descriptor ?? CLAUDE_RUN_AGENT, null);
    handle = await conn.ctx.open(opts.dir);
    await handle.setMode(mode);
    const result = await withTimeout(handle.prompt(opts.task, opts.onDelta, opts.onToolCall), timeoutMs);
    return { ok: true, result, sandbox };
  } catch (err) {
    return { ok: false, result: { text: "", toolCalls: [] }, error: (err as Error).message, sandbox };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}
```

(d) Delete the old `defaultRunConnectFn` arrow body (lines ~196-214) — replaced by (b). Update the SECURITY doc-comment above it to say auto-allow is now safe-by-default on the isolated path and deny on child-spawn (env escape hatch retained).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -b && npx vitest run dist/gem/__tests__/acpRun.test.js dist/gem/__tests__/sandbox.test.js`
Expected: PASS (existing acpRun tests + the new outcome test + Task 3's selection tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/acpRun.ts src/gem/__tests__/acpRun.test.ts
git commit -m "feat(sandbox): auto-select backend in runGemWithAgent; report it in the outcome (#4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Thread `sandbox` through the schema + REST/SSE surface

**Files:**
- Modify: `src/schemas.ts:466-470` (`GemRunOutcomeSchema`)
- Test: `src/__tests__/gem.controller.test.ts` (assert `run.sandbox` present on `POST /api/gem/run`)

**Interfaces:**
- Consumes: `GemRunOutcome.sandbox` from Task 4. `runGem.ts`/controller/`gemRunStream.ts` pass `run` through unchanged — only the schema must accept the new field.

- [ ] **Step 1: Write the failing test**

Find the existing `POST /api/gem/run` test in `src/__tests__/gem.controller.test.ts` (it injects a fake via `setRunConnectFnForTests`). Add to its assertions:

```ts
expect(res.body.run.sandbox).toEqual({ backend: "injected", isolated: false });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/__tests__/gem.controller.test.js`
Expected: FAIL — response `run` has no `sandbox` (stripped by the zod response schema).

- [ ] **Step 3: Write the implementation**

In `src/schemas.ts`, extend `GemRunOutcomeSchema`:

```ts
export const GemRunOutcomeSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  result: RunResultSchema,
  sandbox: z.object({ backend: z.string(), isolated: z.boolean() }),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -b && npx vitest run dist/__tests__/gem.controller.test.js dist/__tests__/gemRunStream.test.js`
Expected: PASS — `run.sandbox` now survives the response schema; SSE `done` event carries it too.

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(sandbox): expose run sandbox {backend,isolated} on the REST/SSE surface (#4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Full-suite green + manual smoke + docs

**Files:**
- Modify: `docs/testbed-and-run.md` (one paragraph on sandboxed runs + auto-allow policy)

- [ ] **Step 1: Build clean and run the FULL suite**

Run: `rm -rf dist *.tsbuildinfo && npx tsc -b && npx vitest run`
Expected: all tests pass (prior count + the new sandbox/boundary tests; boundary test runs on macOS, skips elsewhere).

- [ ] **Step 2: Manual smoke (macOS) — confirm selection picks the isolated backend**

Run:
```bash
node -e "import('./dist/gem/sandbox.js').then(m=>{const s=m.selectRunBackend('/tmp/x');console.log(s.backend.id, s.backend.isolated)})"
```
Expected on macOS: `macos-seatbelt true`. On Linux without bwrap: `child-spawn false`.

- [ ] **Step 3: Document**

Add to `docs/testbed-and-run.md` a short subsection: runs now auto-select an OS-native sandbox (`macos-seatbelt`/`linux-bubblewrap`) that confines filesystem writes to the run dir; on the sandboxed path tool calls are auto-approved, and on the unsandboxed fallback they require approval unless `AGENTGEM_GEM_RUN_AUTOALLOW=1`. Note network/reads are not restricted in v1.

- [ ] **Step 4: Commit**

```bash
git add docs/testbed-and-run.md
git commit -m "docs(sandbox): document sandboxed Gem runs + auto-allow policy (#4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Pluggable `SandboxBackend` registry → Task 3.
- OS-native backends (seatbelt/bwrap) + command wrapping → Tasks 1, 3.
- Real write-confinement boundary → Task 2 (macOS) + Task 1 (bwrap argv).
- Capability-gated auto-allow (isolated→allow, child-spawn→deny+env) → Tasks 3 (`envPermission`, isolated `"allow"`) + 4 (`defaultRunConnectFn`).
- Auto-detect + fall back to deny → Task 3 (`selectRunBackend` → `childSpawnBackend`).
- Observability `{backend,isolated}` → Tasks 4 (outcome) + 5 (schema/SSE).
- Testing (unit selection, profile gen, real boundary) → Tasks 1, 2, 3, 5.
- Out-of-scope (agentOS, egress, Windows) → not implemented; noted in docs (Task 6).

**Placeholder scan:** none — every code/test step shows full content.

**Type consistency:** `SandboxBackend`, `selectRunBackend`, `connectRunSession(descriptor, permission, app?)`, `envPermission`, `wrapWithSandbox(kind, runDir, command)`, `GemRunOutcome.sandbox:{backend,isolated}` used identically across Tasks 1/3/4/5. The `injected` backend label is used in both Task 4 (impl) and Tasks 4/5 (tests).

**Ordering note:** Tasks 3 and 4 are mutually referencing (`sandbox.ts` ↔ `acpRun.ts`). Land Task 4 Step 3(b) (`connectRunSession` extraction) before compiling Task 3, or implement both before the first `tsc -b`. Flagged inline in Task 3 Step 4.

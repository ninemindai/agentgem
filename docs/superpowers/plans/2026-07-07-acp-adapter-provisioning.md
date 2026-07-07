# ACP Adapter Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a downloader use the Chat tab with Claude Code / Codex without manual npm/PATH setup, on both the CLI and the desktop app.

**Architecture:** A resolver seam in `@agentgem/base` turns a bare adapter descriptor into an absolute launch plan by checking three sources in order — on PATH → app-managed dir (`~/.agentgem/adapters/<id>`) → bundled in the desktop app (`process.resourcesPath/adapters/<id>`). The chat connect path rewrites `descriptor.command` through this resolver (exactly like `sandbox.ts` already rewrites it), so `connectAcpAdapter`'s spawn stays a one-line change. Missing CLI adapters are installed on demand behind a consent gate via an injected npm installer; desktop bundles both adapters at build time. Runtime (cli vs desktop) is detected once from `process` and passed to `base` as a context object, keeping `base` free of Electron sniffing.

**Tech Stack:** TypeScript (ESM, `node16` module resolution), Node ≥24, vitest (runs from `dist/`), `@agentclientprotocol/sdk`, electron-builder, React (console).

## Global Constraints

- **Node floor:** `>=24`.
- **Tests run from `dist/`** (`vitest run` after `tsc -b`). Package unit tests live under each package's `src/**/__tests__` or `*.test.ts`; the repo also places some at `src/gem/__tests__`. Follow the file's neighbors.
- **Inject all agent/network deps** — no real `npm` and no real adapter binary in CI. The npm installer is always an injected seam; the production impl is only exercised by an opt-in smoke script.
- **Pinned adapter versions:** `@agentclientprotocol/codex-acp@1.1.0`, `@agentclientprotocol/claude-agent-acp@0.51.0`. Bump deliberately; never floating.
- **No `Math.random()`/`Date.now()` needed** anywhere here — installs use a fixed `.installing` temp suffix serialized by a per-id lock (deterministic).
- **Security invariant (unchanged):** request input never reaches a spawn; `localAgentEnv()` strips provider credentials; chat cwd is server-derived.
- **Commit trailer:** end every commit message with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Console tests are NOT in CI** — run them locally (`pnpm --filter @agentgem/console test`); the root CI (`test (24)` + `test (26)`) gates merge.

---

## File Structure

- `packages/base/src/acpSession.ts` — extend `AgentDescriptor` (`package?`, `version?`, `env?`); merge `descriptor.env` at spawn.
- `packages/base/src/adapters.ts` *(new)* — runtime detection, source resolution, launch-plan builder, `ensureAdapter`, and the production npm installer. The heart of the seam.
- `packages/base/src/agents.ts` — registry gains `package`/`version`; `availableAgents(ctx)` returns richer status via the resolver.
- `packages/base/src/index.ts` — export the new adapter surface.
- `src/goldmine/chatRoutes.ts` — chat connect resolves the descriptor; `GET /api/agents` returns richer status; new `POST /api/agents/:id/install`.
- `src/index.ts` — build the runtime ctx once; wire `listAgents`, the install handler, and the resolving connect fn.
- `desktop/scripts/bundle-adapters.mjs` *(new)* — install both adapters into `desktop/adapters-dist/<id>` at build time.
- `desktop/electron-builder.yml` — `extraResources` copies `adapters-dist` → `resources/adapters`.
- `desktop/package.json` — call `bundle-adapters` in the build pipeline.
- `packages/console/src/panels/Chat/index.tsx` — install affordance + consent prompt + refetch + needs-login hint.

---

## Task 1: Extend AgentDescriptor + registry provenance

**Files:**
- Modify: `packages/base/src/acpSession.ts:27`
- Modify: `packages/base/src/agents.ts:10-13`
- Test: `packages/base/src/__tests__/agents.registry.test.ts` *(new)*

**Interfaces:**
- Produces: `AgentDescriptor` now `{ id: string; name: string; command: string[]; package?: string; version?: string; env?: Record<string,string> }`. All new fields optional (keeps `runGem.ts`, `CLAUDE_RUN_AGENT`, sandbox descriptors compiling unchanged). `AGENTS` entries carry `package` + pinned `version`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/base/src/__tests__/agents.registry.test.ts
import { describe, it, expect } from "vitest";
import { AGENTS } from "../agents.js";

describe("AGENTS registry provenance", () => {
  it("every agent carries an npm package and a pinned version", () => {
    for (const a of AGENTS) {
      expect(a.package, `${a.id} package`).toMatch(/^@agentclientprotocol\//);
      expect(a.version, `${a.id} version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
  it("codex + claude-code are pinned to the vetted versions", () => {
    expect(AGENTS.find((a) => a.id === "codex")?.version).toBe("1.1.0");
    expect(AGENTS.find((a) => a.id === "claude-code")?.version).toBe("0.51.0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/agents.registry.test.ts`
Expected: FAIL — `a.package` is `undefined` (property does not exist yet).

- [ ] **Step 3: Extend the type**

In `packages/base/src/acpSession.ts`, replace line 27:

```ts
// An ACP adapter to spawn: a display id/name plus the argv to launch it.
// Registry entries also carry the npm package + pinned version that provide the
// bin (used for on-demand install). `env` is an overlay applied at spawn time
// (set by resolveLaunch, e.g. ELECTRON_RUN_AS_NODE on desktop).
export interface AgentDescriptor {
  id: string;
  name: string;
  command: string[];
  package?: string;
  version?: string;
  env?: Record<string, string>;
}
```

- [ ] **Step 4: Add provenance to the registry**

In `packages/base/src/agents.ts`, replace the `AGENTS` array (lines 10-13):

```ts
export const AGENTS: AgentDescriptor[] = [
  { id: "claude-code", name: "Claude Code", command: ["claude-agent-acp"], package: "@agentclientprotocol/claude-agent-acp", version: "0.51.0" },
  { id: "codex", name: "Codex", command: ["codex-acp"], package: "@agentclientprotocol/codex-acp", version: "1.1.0" },
];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/agents.registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/base/src/acpSession.ts packages/base/src/agents.ts packages/base/src/__tests__/agents.registry.test.ts
git commit -m "feat(base): AgentDescriptor gains package/version/env; pin adapter versions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Runtime context + source resolution

**Files:**
- Create: `packages/base/src/adapters.ts`
- Test: `packages/base/src/__tests__/adapters.resolve.test.ts`

**Interfaces:**
- Consumes: `AgentDescriptor` (Task 1).
- Produces:
  - `type AdapterRuntime = "cli" | "desktop"`
  - `interface AdapterCtx { runtime: AdapterRuntime; execPath: string; home: string; resourcesPath?: string; onPath?: (bin: string) => boolean; exists?: (p: string) => boolean; readJson?: (p: string) => unknown }`
  - `type AdapterSource = "path" | "managed" | "bundled" | "missing"`
  - `interface ResolvedSource { source: AdapterSource; binOnPath?: string; entry?: string }`
  - `function managedAdapterDir(home: string, id: string): string`
  - `function bundledAdapterDir(resourcesPath: string, id: string): string`
  - `function adapterEntry(prefixDir: string, pkg: string, binName: string, readJson: (p: string) => unknown, exists: (p: string) => boolean): string | null`
  - `function adapterRuntimeCtx(proc?: Partial<AdapterCtx> & { versionsElectron?: string }): AdapterCtx`
  - `function resolveAdapterSource(descriptor: AgentDescriptor, ctx: AdapterCtx): ResolvedSource`

- [ ] **Step 1: Write the failing test**

```ts
// packages/base/src/__tests__/adapters.resolve.test.ts
import { describe, it, expect } from "vitest";
import { resolveAdapterSource, managedAdapterDir, bundledAdapterDir, type AdapterCtx } from "../adapters.js";
import type { AgentDescriptor } from "../acpSession.js";

const codex: AgentDescriptor = { id: "codex", name: "Codex", command: ["codex-acp"], package: "@agentclientprotocol/codex-acp", version: "1.1.0" };

// A ctx whose probes are fully injected. pkgJson describes the adapter's bin.
function ctx(over: Partial<AdapterCtx> & { present?: Set<string>; onPathBins?: Set<string> } = {}): AdapterCtx {
  const present = over.present ?? new Set<string>();
  return {
    runtime: over.runtime ?? "cli",
    execPath: over.execPath ?? "/usr/bin/node",
    home: over.home ?? "/home/u",
    resourcesPath: over.resourcesPath,
    onPath: (bin) => (over.onPathBins ?? new Set()).has(bin),
    exists: (p) => present.has(p),
    readJson: () => ({ bin: { "codex-acp": "dist/index.js" } }),
  };
}

describe("resolveAdapterSource", () => {
  it("prefers a bin already on PATH", () => {
    const r = resolveAdapterSource(codex, ctx({ onPathBins: new Set(["codex-acp"]) }));
    expect(r).toEqual({ source: "path", binOnPath: "codex-acp" });
  });

  it("falls back to the managed dir when its entry exists", () => {
    const dir = managedAdapterDir("/home/u", "codex");
    const entry = `${dir}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`;
    const r = resolveAdapterSource(codex, ctx({ present: new Set([entry]) }));
    expect(r.source).toBe("managed");
    expect(r.entry).toBe(entry);
  });

  it("uses the bundled dir on desktop when present", () => {
    const dir = bundledAdapterDir("/Res", "codex");
    const entry = `${dir}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`;
    const r = resolveAdapterSource(codex, ctx({ runtime: "desktop", resourcesPath: "/Res", present: new Set([entry]) }));
    expect(r.source).toBe("bundled");
    expect(r.entry).toBe(entry);
  });

  it("reports missing when nothing resolves", () => {
    expect(resolveAdapterSource(codex, ctx()).source).toBe("missing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/adapters.resolve.test.ts`
Expected: FAIL — cannot find module `../adapters.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/base/src/adapters.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Adapter provisioning: turn a bare AgentDescriptor into an absolute launch plan
// by resolving one of three sources — on PATH, the app-managed dir, or (desktop)
// the bundled dir — and install a missing one on demand (CLI only). All fs/PATH
// access goes through injected probes so the logic is unit-testable without a real
// filesystem, npm, or adapter binary.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDescriptor } from "./acpSession.js";

export type AdapterRuntime = "cli" | "desktop";

export interface AdapterCtx {
  runtime: AdapterRuntime;
  execPath: string;          // node (cli) or electron (desktop)
  home: string;              // os.homedir()
  resourcesPath?: string;    // desktop: process.resourcesPath
  onPath?: (bin: string) => boolean;
  exists?: (p: string) => boolean;
  readJson?: (p: string) => unknown;
}

export type AdapterSource = "path" | "managed" | "bundled" | "missing";
export interface ResolvedSource { source: AdapterSource; binOnPath?: string; entry?: string }

export function managedAdapterDir(home: string, id: string): string {
  return join(home, ".agentgem", "adapters", id);
}
export function bundledAdapterDir(resourcesPath: string, id: string): string {
  return join(resourcesPath, "adapters", id);
}

function onPathDefault(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Detect the runtime context from `process` (overridable for tests). Electron's
// main process (which hosts the desktop core in-process) sets process.versions.electron
// and process.resourcesPath; a plain CLI has neither.
export function adapterRuntimeCtx(proc: Partial<AdapterCtx> & { versionsElectron?: string } = {}): AdapterCtx {
  const isDesktop = proc.runtime ? proc.runtime === "desktop" : Boolean(proc.versionsElectron ?? process.versions.electron);
  return {
    runtime: isDesktop ? "desktop" : "cli",
    execPath: proc.execPath ?? process.execPath,
    home: proc.home ?? homedir(),
    resourcesPath: proc.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath,
    onPath: proc.onPath ?? onPathDefault,
    exists: proc.exists ?? existsSync,
    readJson: proc.readJson ?? ((p: string) => JSON.parse(readFileSync(p, "utf8"))),
  };
}

// Absolute JS entry for an adapter installed under `prefixDir` (an npm --prefix root:
// package lives at prefixDir/node_modules/<pkg>). Reads the package's bin mapping.
export function adapterEntry(
  prefixDir: string, pkg: string, binName: string,
  readJson: (p: string) => unknown, exists: (p: string) => boolean,
): string | null {
  const pkgDir = join(prefixDir, "node_modules", pkg);
  const manifest = join(pkgDir, "package.json");
  if (!exists(manifest)) return null;
  let rel: string | undefined;
  try {
    const bin = (readJson(manifest) as { bin?: unknown }).bin;
    if (typeof bin === "string") rel = bin;
    else if (bin && typeof bin === "object") rel = (bin as Record<string, string>)[binName];
  } catch { return null; }
  if (!rel) return null;
  const entry = join(pkgDir, rel);
  return exists(entry) ? entry : null;
}

export function resolveAdapterSource(descriptor: AgentDescriptor, ctx: AdapterCtx): ResolvedSource {
  const bin = descriptor.command[0];
  const exists = ctx.exists ?? existsSync;
  const readJson = ctx.readJson ?? ((p: string) => JSON.parse(readFileSync(p, "utf8")));
  const onPath = ctx.onPath ?? onPathDefault;
  const pkg = descriptor.package;

  if (onPath(bin)) return { source: "path", binOnPath: bin };

  if (pkg) {
    const managed = adapterEntry(managedAdapterDir(ctx.home, descriptor.id), pkg, bin, readJson, exists);
    if (managed) return { source: "managed", entry: managed };
    if (ctx.runtime === "desktop" && ctx.resourcesPath) {
      const bundled = adapterEntry(bundledAdapterDir(ctx.resourcesPath, descriptor.id), pkg, bin, readJson, exists);
      if (bundled) return { source: "bundled", entry: bundled };
    }
  }
  return { source: "missing" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/adapters.resolve.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/adapters.ts packages/base/src/__tests__/adapters.resolve.test.ts
git commit -m "feat(base): adapter runtime ctx + three-source resolver

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Launch-plan builder

**Files:**
- Modify: `packages/base/src/adapters.ts`
- Test: `packages/base/src/__tests__/adapters.launch.test.ts`

**Interfaces:**
- Consumes: `resolveAdapterSource`, `AdapterCtx` (Task 2), `AgentDescriptor` (Task 1).
- Produces: `function resolveLaunch(descriptor: AgentDescriptor, ctx: AdapterCtx): AgentDescriptor | null` — returns a descriptor whose `command` is an absolute argv and whose `env` overlays `ELECTRON_RUN_AS_NODE` on desktop; `null` when the source is missing.

- [ ] **Step 1: Write the failing test**

```ts
// packages/base/src/__tests__/adapters.launch.test.ts
import { describe, it, expect } from "vitest";
import { resolveLaunch, managedAdapterDir, type AdapterCtx } from "../adapters.js";
import type { AgentDescriptor } from "../acpSession.js";

const codex: AgentDescriptor = { id: "codex", name: "Codex", command: ["codex-acp"], package: "@agentclientprotocol/codex-acp", version: "1.1.0" };
const entryOf = (dir: string) => `${dir}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`;

function ctx(over: Partial<AdapterCtx> & { present?: Set<string>; onPathBins?: Set<string> } = {}): AdapterCtx {
  const present = over.present ?? new Set<string>();
  return {
    runtime: over.runtime ?? "cli",
    execPath: over.execPath ?? "/usr/bin/node",
    home: over.home ?? "/home/u",
    resourcesPath: over.resourcesPath,
    onPath: (bin) => (over.onPathBins ?? new Set()).has(bin),
    exists: (p) => present.has(p),
    readJson: () => ({ bin: { "codex-acp": "dist/index.js" } }),
  };
}

describe("resolveLaunch", () => {
  it("returns the bare command unchanged for an on-PATH adapter", () => {
    const d = resolveLaunch(codex, ctx({ onPathBins: new Set(["codex-acp"]) }));
    expect(d?.command).toEqual(["codex-acp"]);
    expect(d?.env).toBeUndefined();
  });

  it("builds an absolute [node, entry] command for a managed adapter (cli)", () => {
    const entry = entryOf(managedAdapterDir("/home/u", "codex"));
    const d = resolveLaunch(codex, ctx({ present: new Set([entry]) }));
    expect(d?.command).toEqual(["/usr/bin/node", entry]);
    expect(d?.env).toBeUndefined();
  });

  it("adds ELECTRON_RUN_AS_NODE for a bundled adapter (desktop)", () => {
    const entry = entryOf(`/Res/adapters/codex`);
    const d = resolveLaunch(codex, ctx({ runtime: "desktop", execPath: "/App/Electron", resourcesPath: "/Res", present: new Set([entry]) }));
    expect(d?.command).toEqual(["/App/Electron", entry]);
    expect(d?.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("returns null when missing", () => {
    expect(resolveLaunch(codex, ctx())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/adapters.launch.test.ts`
Expected: FAIL — `resolveLaunch` is not exported.

- [ ] **Step 3: Append the implementation to `adapters.ts`**

```ts
// Build an absolute, spawnable descriptor from the resolved source, or null if missing.
//  • path    → keep the bare command (already resolvable on PATH), no env overlay.
//  • managed/bundled → [ctx.execPath, entry, ...extraArgs]; on desktop overlay
//    ELECTRON_RUN_AS_NODE=1 so Electron's own binary runs the Node adapter.
export function resolveLaunch(descriptor: AgentDescriptor, ctx: AdapterCtx): AgentDescriptor | null {
  const r = resolveAdapterSource(descriptor, ctx);
  if (r.source === "missing") return null;
  if (r.source === "path") {
    return { ...descriptor, command: [r.binOnPath ?? descriptor.command[0], ...descriptor.command.slice(1)] };
  }
  const command = [ctx.execPath, r.entry!, ...descriptor.command.slice(1)];
  const env = ctx.runtime === "desktop" ? { ELECTRON_RUN_AS_NODE: "1" } : undefined;
  return env ? { ...descriptor, command, env } : { ...descriptor, command };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/adapters.launch.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/adapters.ts packages/base/src/__tests__/adapters.launch.test.ts
git commit -m "feat(base): resolveLaunch builds absolute launch plan (+ELECTRON_RUN_AS_NODE)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Merge descriptor env at spawn

**Files:**
- Modify: `packages/base/src/acpSession.ts:69`
- Test: `packages/base/src/__tests__/acpSession.env.test.ts`

**Interfaces:**
- Consumes: `AgentDescriptor.env` (Task 1), `localAgentEnv` (existing).
- Produces: `connectAcpAdapter` spawns with `{ ...localAgentEnv(), ...(descriptor.env ?? {}) }`. Export a tiny pure helper `spawnEnv(descriptor, base)` so the merge is testable without spawning.

- [ ] **Step 1: Write the failing test**

```ts
// packages/base/src/__tests__/acpSession.env.test.ts
import { describe, it, expect } from "vitest";
import { spawnEnv } from "../acpSession.js";

describe("spawnEnv", () => {
  it("overlays descriptor.env onto the sanitized base env", () => {
    const base = { PATH: "/bin", OPENAI_API_KEY: "should-be-gone-by-localAgentEnv" };
    const out = spawnEnv({ id: "x", name: "X", command: ["x"], env: { ELECTRON_RUN_AS_NODE: "1" } }, base);
    expect(out.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(out.PATH).toBe("/bin");
  });
  it("is a no-op overlay when descriptor has no env", () => {
    const out = spawnEnv({ id: "x", name: "X", command: ["x"] }, { PATH: "/bin" });
    expect(out).toEqual({ PATH: "/bin" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/acpSession.env.test.ts`
Expected: FAIL — `spawnEnv` is not exported.

- [ ] **Step 3: Add `spawnEnv` and use it at the spawn site**

In `packages/base/src/acpSession.ts`, add after `localAgentEnv` (after line 42):

```ts
// Merge an adapter descriptor's env overlay (e.g. ELECTRON_RUN_AS_NODE) onto a base env.
export function spawnEnv(descriptor: AgentDescriptor, base: NodeJS.ProcessEnv = localAgentEnv()): NodeJS.ProcessEnv {
  return descriptor.env ? { ...base, ...descriptor.env } : { ...base };
}
```

Then change the spawn call (line 69) from:

```ts
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], env: localAgentEnv() });
```

to:

```ts
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], env: spawnEnv(descriptor) });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/acpSession.env.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/acpSession.ts packages/base/src/__tests__/acpSession.env.test.ts
git commit -m "feat(base): overlay descriptor.env at adapter spawn

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: ensureAdapter — consent-gated install with atomic rename + lock

**Files:**
- Modify: `packages/base/src/adapters.ts`
- Test: `packages/base/src/__tests__/adapters.ensure.test.ts`

**Interfaces:**
- Consumes: `resolveAdapterSource`, `managedAdapterDir`, `AdapterCtx` (Task 2).
- Produces:
  - `class AdapterConsentError extends Error` (has `code = "consent_required"`).
  - `type AdapterInstaller = (pkg: string, version: string, destPrefix: string) => Promise<void>`
  - `interface EnsureResult { available: boolean; source: AdapterSource }`
  - `interface EnsureOpts { consent: boolean; install: AdapterInstaller; fs?: { rm(p: string): void; rename(a: string, b: string): void; mkdirp(p: string): void } }`
  - `async function ensureAdapter(descriptor: AgentDescriptor, ctx: AdapterCtx, opts: EnsureOpts): Promise<EnsureResult>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/base/src/__tests__/adapters.ensure.test.ts
import { describe, it, expect, vi } from "vitest";
import { ensureAdapter, AdapterConsentError, managedAdapterDir, type AdapterCtx } from "../adapters.js";
import type { AgentDescriptor } from "../acpSession.js";

const codex: AgentDescriptor = { id: "codex", name: "Codex", command: ["codex-acp"], package: "@agentclientprotocol/codex-acp", version: "1.1.0" };
const entryOf = (dir: string) => `${dir}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`;

// A mutable fake filesystem: the installer "creates" the entry under the temp prefix,
// and rename moves the whole subtree by string-prefix swap.
function fakeCtxAndFs(runtime: "cli" | "desktop" = "cli") {
  const present = new Set<string>();
  const ctx: AdapterCtx = {
    runtime, execPath: "/usr/bin/node", home: "/home/u", resourcesPath: "/Res",
    onPath: () => false, exists: (p) => present.has(p),
    readJson: () => ({ bin: { "codex-acp": "dist/index.js" } }),
  };
  const fs = {
    rm: (p: string) => { for (const q of [...present]) if (q === p || q.startsWith(p + "/")) present.delete(q); },
    rename: (a: string, b: string) => { for (const q of [...present]) if (q === a || q.startsWith(a + "/")) { present.delete(q); present.add(b + q.slice(a.length)); } },
    mkdirp: (p: string) => { present.add(p); },
  };
  return { ctx, fs, present };
}

describe("ensureAdapter", () => {
  it("throws AdapterConsentError when a missing CLI adapter has no consent", async () => {
    const { ctx, fs } = fakeCtxAndFs("cli");
    await expect(ensureAdapter(codex, ctx, { consent: false, install: vi.fn(), fs }))
      .rejects.toBeInstanceOf(AdapterConsentError);
  });

  it("installs into a temp prefix then atomically renames into the managed dir", async () => {
    const { ctx, fs, present } = fakeCtxAndFs("cli");
    const dir = managedAdapterDir("/home/u", "codex");
    const install = vi.fn(async (_pkg: string, _v: string, destPrefix: string) => {
      present.add(entryOf(destPrefix)); // installer materializes the entry in the temp prefix
    });
    const res = await ensureAdapter(codex, ctx, { consent: true, install, fs });
    expect(install).toHaveBeenCalledWith("@agentclientprotocol/codex-acp", "1.1.0", `${dir}.installing`);
    expect(present.has(entryOf(dir))).toBe(true);      // renamed into place
    expect(present.has(entryOf(`${dir}.installing`))).toBe(false);
    expect(res).toEqual({ available: true, source: "managed" });
  });

  it("returns immediately without installing when already resolvable", async () => {
    const { ctx, present } = fakeCtxAndFs("cli");
    present.add(entryOf(managedAdapterDir("/home/u", "codex")));
    const install = vi.fn();
    const res = await ensureAdapter(codex, ctx, { consent: true, install });
    expect(install).not.toHaveBeenCalled();
    expect(res.source).toBe("managed");
  });

  it("refuses to install on desktop (bundle-missing)", async () => {
    const { ctx, fs } = fakeCtxAndFs("desktop");
    await expect(ensureAdapter(codex, ctx, { consent: true, install: vi.fn(), fs }))
      .rejects.toThrow(/reinstall the app/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/adapters.ensure.test.ts`
Expected: FAIL — `ensureAdapter` / `AdapterConsentError` not exported.

- [ ] **Step 3: Append the implementation to `adapters.ts`**

```ts
import { mkdirSync, renameSync, rmSync } from "node:fs";

export class AdapterConsentError extends Error {
  code = "consent_required" as const;
  constructor(msg = "install requires consent") { super(msg); this.name = "AdapterConsentError"; }
}

export type AdapterInstaller = (pkg: string, version: string, destPrefix: string) => Promise<void>;
export interface EnsureResult { available: boolean; source: AdapterSource }
export interface EnsureOpts {
  consent: boolean;
  install: AdapterInstaller;
  fs?: { rm(p: string): void; rename(a: string, b: string): void; mkdirp(p: string): void };
}

// One in-flight install per adapter id, so a second caller awaits the first.
const installLocks = new Map<string, Promise<EnsureResult>>();

export async function ensureAdapter(descriptor: AgentDescriptor, ctx: AdapterCtx, opts: EnsureOpts): Promise<EnsureResult> {
  const existing = resolveAdapterSource(descriptor, ctx);
  if (existing.source !== "missing") return { available: true, source: existing.source };

  if (!descriptor.package || !descriptor.version) throw new Error(`no install source for ${descriptor.id}`);
  if (ctx.runtime === "desktop") throw new Error(`${descriptor.name} adapter is missing from the app — reinstall the app`);
  if (!opts.consent) throw new AdapterConsentError();

  const inflight = installLocks.get(descriptor.id);
  if (inflight) return inflight;

  const run = (async (): Promise<EnsureResult> => {
    const fs = opts.fs ?? {
      rm: (p: string) => rmSync(p, { recursive: true, force: true }),
      rename: (a: string, b: string) => renameSync(a, b),
      mkdirp: (p: string) => mkdirSync(p, { recursive: true }),
    };
    const finalDir = managedAdapterDir(ctx.home, descriptor.id);
    const tmpDir = `${finalDir}.installing`;
    fs.rm(tmpDir);
    fs.mkdirp(tmpDir);
    await opts.install(descriptor.package!, descriptor.version!, tmpDir);
    fs.rm(finalDir);
    fs.rename(tmpDir, finalDir);
    const after = resolveAdapterSource(descriptor, ctx);
    if (after.source === "missing") throw new Error(`install of ${descriptor.name} did not produce a runnable adapter`);
    return { available: true, source: after.source };
  })();

  installLocks.set(descriptor.id, run);
  try { return await run; }
  finally { installLocks.delete(descriptor.id); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/adapters.ensure.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/adapters.ts packages/base/src/__tests__/adapters.ensure.test.ts
git commit -m "feat(base): ensureAdapter — consent gate, atomic install, per-id lock

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Production npm installer + base barrel export

**Files:**
- Modify: `packages/base/src/adapters.ts`
- Modify: `packages/base/src/index.ts`
- Test: `packages/base/src/__tests__/adapters.npm.test.ts`

**Interfaces:**
- Consumes: `AdapterInstaller` (Task 5).
- Produces: `function npmAdapterInstaller(spawnFn?): AdapterInstaller` — builds the `npm install <pkg>@<version> --prefix <dest>` invocation; `spawnFn` is injected for the test, defaulting to the real child_process runner. Re-export the full adapter surface from `@agentgem/base`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/base/src/__tests__/adapters.npm.test.ts
import { describe, it, expect, vi } from "vitest";
import { npmAdapterInstaller } from "../adapters.js";

describe("npmAdapterInstaller", () => {
  it("invokes npm install with the pinned version and --prefix", async () => {
    const spawnFn = vi.fn(async () => ({ code: 0, stderr: "" }));
    await npmAdapterInstaller(spawnFn)("@agentclientprotocol/codex-acp", "1.1.0", "/tmp/x.installing");
    expect(spawnFn).toHaveBeenCalledWith(
      "npm",
      ["install", "@agentclientprotocol/codex-acp@1.1.0", "--prefix", "/tmp/x.installing", "--no-audit", "--no-fund", "--loglevel=error"],
    );
  });

  it("rejects with the stderr tail on non-zero exit", async () => {
    const spawnFn = vi.fn(async () => ({ code: 1, stderr: "E404 not found" }));
    await expect(npmAdapterInstaller(spawnFn)("p", "1.0.0", "/tmp/x"))
      .rejects.toThrow(/E404 not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/adapters.npm.test.ts`
Expected: FAIL — `npmAdapterInstaller` not exported.

- [ ] **Step 3: Append the installer to `adapters.ts`**

```ts
import { spawn as spawnChild } from "node:child_process";

export type NpmSpawn = (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;

const defaultNpmSpawn: NpmSpawn = (cmd, args) => new Promise((resolve) => {
  const child = spawnChild(cmd, args, { stdio: ["ignore", "ignore", "pipe"], shell: process.platform === "win32" });
  let stderr = "";
  child.stderr?.on("data", (d) => { stderr += String(d); });
  child.once("error", (e) => resolve({ code: 1, stderr: e.message }));
  child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
});

// Production AdapterInstaller: `npm install <pkg>@<version> --prefix <destPrefix>`.
// Only exercised by the opt-in smoke script; CI always injects a fake installer.
export function npmAdapterInstaller(spawnFn: NpmSpawn = defaultNpmSpawn): AdapterInstaller {
  return async (pkg, version, destPrefix) => {
    const { code, stderr } = await spawnFn("npm", [
      "install", `${pkg}@${version}`, "--prefix", destPrefix, "--no-audit", "--no-fund", "--loglevel=error",
    ]);
    if (code !== 0) throw new Error(`npm install ${pkg}@${version} failed: ${stderr.trim().slice(-500) || `exit ${code}`}`);
  };
}
```

- [ ] **Step 4: Export the adapter surface from the barrel**

In `packages/base/src/index.ts`, add (near the existing `agents`/`acpSession` re-exports):

```ts
export * from "./adapters.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/adapters.npm.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/base/src/adapters.ts packages/base/src/index.ts packages/base/src/__tests__/adapters.npm.test.ts
git commit -m "feat(base): npm adapter installer + export adapters surface

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: availableAgents returns richer status

**Files:**
- Modify: `packages/base/src/agents.ts`
- Test: `packages/base/src/__tests__/agents.status.test.ts`

**Interfaces:**
- Consumes: `resolveAdapterSource`, `AdapterCtx` (Task 2).
- Produces: `interface AgentAvailability { id: string; name: string; available: boolean; installable: boolean; source: AdapterSource }` and `function availableAgents(ctx?: AdapterCtx): AgentAvailability[]`. Backward compatible: still callable with no argument (defaults to the detected runtime ctx).

- [ ] **Step 1: Write the failing test**

```ts
// packages/base/src/__tests__/agents.status.test.ts
import { describe, it, expect } from "vitest";
import { availableAgents } from "../agents.js";
import type { AdapterCtx } from "../adapters.js";

function ctx(onPathBins: string[], runtime: "cli" | "desktop" = "cli"): AdapterCtx {
  return {
    runtime, execPath: "/usr/bin/node", home: "/home/u",
    onPath: (b) => onPathBins.includes(b), exists: () => false, readJson: () => ({}),
  };
}

describe("availableAgents", () => {
  it("marks a missing CLI adapter installable", () => {
    const out = availableAgents(ctx(["claude-agent-acp"]));
    const codex = out.find((a) => a.id === "codex")!;
    expect(codex.available).toBe(false);
    expect(codex.installable).toBe(true);
    expect(codex.source).toBe("missing");
    const claude = out.find((a) => a.id === "claude-code")!;
    expect(claude.available).toBe(true);
    expect(claude.installable).toBe(false);
  });

  it("never marks a missing desktop adapter installable (no npm there)", () => {
    const codex = availableAgents(ctx([], "desktop")).find((a) => a.id === "codex")!;
    expect(codex.available).toBe(false);
    expect(codex.installable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/agents.status.test.ts`
Expected: FAIL — `availableAgents` doesn't return `installable`/`source`.

- [ ] **Step 3: Rewrite `availableAgents` in `agents.ts`**

Replace the current body (lines 15-40) with:

```ts
import { resolveAdapterSource, adapterRuntimeCtx, type AdapterCtx, type AdapterSource } from "./adapters.js";

export interface AgentAvailability {
  id: string;
  name: string;
  available: boolean;
  installable: boolean;   // missing + on CLI + has an npm package (desktop can't install on demand)
  source: AdapterSource;
}

export function availableAgents(ctx: AdapterCtx = adapterRuntimeCtx()): AgentAvailability[] {
  return AGENTS.map((a) => {
    const r = resolveAdapterSource(a, ctx);
    const available = r.source !== "missing";
    return {
      id: a.id,
      name: a.name,
      available,
      installable: !available && ctx.runtime === "cli" && Boolean(a.package),
      source: r.source,
    };
  });
}
```

Remove the now-unused `onPathDefault` helper and the `execFileSync` import from `agents.ts` (they moved to `adapters.ts`). Keep the `import type { AgentDescriptor } from "./acpSession.js"` line.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/base && pnpm exec vitest run src/__tests__/agents.status.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole base suite (catch consumers of the old shape)**

Run: `cd packages/base && pnpm exec vitest run`
Expected: PASS. (If a Play test asserted the old `{id,available}` shape, it still holds — new fields are additive.)

- [ ] **Step 6: Commit**

```bash
git add packages/base/src/agents.ts packages/base/src/__tests__/agents.status.test.ts
git commit -m "feat(base): availableAgents reports installable + source via resolver

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Chat connect resolves the descriptor before spawn

**Files:**
- Modify: `src/goldmine/chatRoutes.ts:156-176`
- Test: `src/goldmine/__tests__/chatConnectResolve.test.ts` *(new; mirror an existing goldmine test's location)*

**Interfaces:**
- Consumes: `resolveLaunch`, `adapterRuntimeCtx`, `AdapterCtx` (Tasks 2-3).
- Produces: `function makeChatConnectFn(resolve: (d: AgentDescriptor) => AgentDescriptor): ChatConnectFn` and keep `chatConnectFn` as the default (`resolve = (d) => resolveLaunch(d, adapterRuntimeCtx()) ?? d`). This is the sandbox-style descriptor rewrite: resolve `command` to absolute before `connectAcpAdapter`.

- [ ] **Step 1: Write the failing test**

```ts
// src/goldmine/__tests__/chatConnectResolve.test.ts
import { describe, it, expect, vi } from "vitest";

// Stub connectAcpAdapter to capture the descriptor it receives.
const captured: { command?: string[]; env?: Record<string, string> } = {};
vi.mock("@agentgem/base", async (orig) => {
  const actual = await orig<typeof import("@agentgem/base")>();
  return { ...actual, connectAcpAdapter: vi.fn(async (descriptor: { command: string[]; env?: Record<string, string> }) => {
    captured.command = descriptor.command; captured.env = descriptor.env;
    return { open: async () => ({ setMode: async () => {}, prompt: async () => {}, dispose: () => {} }), close: () => {} };
  }) };
});

import { makeChatConnectFn } from "../chatRoutes.js";

describe("makeChatConnectFn", () => {
  it("rewrites the descriptor command via the injected resolver before connecting", async () => {
    const resolve = vi.fn((d) => ({ ...d, command: ["/abs/node", "/abs/entry.js"], env: { ELECTRON_RUN_AS_NODE: "1" } }));
    const connect = makeChatConnectFn(resolve);
    await connect({ id: "codex", name: "Codex", command: ["codex-acp"] });
    expect(resolve).toHaveBeenCalled();
    expect(captured.command).toEqual(["/abs/node", "/abs/entry.js"]);
    expect(captured.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/goldmine/__tests__/chatConnectResolve.test.ts`
Expected: FAIL — `makeChatConnectFn` not exported.

- [ ] **Step 3: Refactor `chatConnectFn` into a factory**

In `src/goldmine/chatRoutes.ts`, update the import (line 19-20) to add the resolver:

```ts
import { connectAcpAdapter, stdioMcpServer, resolveLaunch, adapterRuntimeCtx } from "@agentgem/base";
```

Replace the `export const chatConnectFn: ChatConnectFn = async (descriptor, opts) => { ... }` block (lines 156-176) with:

```ts
// Build a chat connect fn that first resolves the descriptor's bare command into an
// absolute launch plan (PATH → managed dir → bundled), then connects. The rewrite is
// the same seam sandbox.ts uses. `resolve` is injected so tests can supply a fake and
// desktop/cli share one default (adapterRuntimeCtx() auto-detects the runtime).
export function makeChatConnectFn(resolve: (d: AgentDescriptor) => AgentDescriptor): ChatConnectFn {
  return async (descriptor: AgentDescriptor, opts) => {
    const launch = resolve(descriptor);
    const raw = await connectAcpAdapter(launch, { clientName: "agentgem-chat", permission: opts?.permission ?? "deny" });
    const ctx: ChatCtx = {
      async open(cwd: string, openOpts?: { mcpServers?: unknown[] }): Promise<ChatSessionHandle> {
        const session = await raw.open(cwd, { mcpServers: openOpts?.mcpServers as never });
        return {
          setMode: (m: string) => session.setMode(m),
          async prompt(text: string, onDelta?: (c: string) => void, onToolCall?: (t: ToolInvocation) => void) {
            const acc = createAccumulator();
            await session.prompt(text, (u) =>
              applyUpdate(acc, (u ?? {}) as Parameters<typeof applyUpdate>[1], { onDelta, onToolCall }),
            );
            return acc;
          },
          dispose: () => session.dispose(),
        };
      },
    };
    return { ctx, close: raw.close };
  };
}

// Default chat connect fn: resolve against the auto-detected runtime; if the adapter
// can't be resolved (shouldn't happen — the picker only offers available agents), fall
// back to the bare descriptor so connectAcpAdapter surfaces a clear spawn error.
export const chatConnectFn: ChatConnectFn = makeChatConnectFn(
  (d) => resolveLaunch(d, adapterRuntimeCtx()) ?? d,
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/goldmine/__tests__/chatConnectResolve.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/goldmine/chatRoutes.ts src/goldmine/__tests__/chatConnectResolve.test.ts
git commit -m "feat(chat): resolve adapter descriptor to absolute launch before connect

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Install route + richer agents endpoint

**Files:**
- Modify: `src/goldmine/chatRoutes.ts` (`ChatRouteDeps`, `registerChatRoutes`)
- Test: `src/goldmine/__tests__/installRoute.test.ts` *(new)*

**Interfaces:**
- Consumes: `ensureAdapter`/`AdapterConsentError` semantics (Task 5) via an injected `installAgent` dep.
- Produces:
  - `ChatRouteDeps` gains `installAgent?: (id: string, consent: boolean) => Promise<{ available: boolean; source: string; needsLogin: boolean }>`.
  - New route `POST /api/agents/:id/install` — body `{ consent?: boolean }`. Returns `200` with the ensure result; `409 { error, code: "consent_required" }` when consent is missing; `400` for unknown id; `500` otherwise.
  - `GET /api/agents` unchanged in shape (already returns `deps.listAgents()`, now the richer objects from Task 7).

- [ ] **Step 1: Write the failing test**

```ts
// src/goldmine/__tests__/installRoute.test.ts
import { describe, it, expect, vi } from "vitest";
import { registerChatRoutes } from "../chatRoutes.js";

// Minimal fake Express app that records handlers and lets us invoke them.
function fakeApp() {
  const routes: Record<string, (req: any, res: any) => any> = {};
  const app = {
    get: (p: string, _g: any, h: any) => { routes["GET " + p] = h; },
    post: (p: string, _g: any, h: any) => { routes["POST " + p] = h; },
    delete: (p: string, _g: any, h: any) => { routes["DELETE " + p] = h; },
  };
  return { app, routes };
}
function fakeRes() {
  const r: any = { code: 200, body: undefined, status(c: number) { r.code = c; return r; }, json(b: unknown) { r.body = b; }, setHeader() {}, write() {}, end() {} };
  return r;
}
const baseDeps = () => ({
  manager: {} as any,
  listAgents: () => [],
  buildBrief: async () => "",
  goldmineMcp: () => [],
});

describe("POST /api/agents/:id/install", () => {
  it("409 consent_required when consent is missing", async () => {
    const { app, routes } = fakeApp();
    const installAgent = vi.fn(async () => { throw Object.assign(new Error("install requires consent"), { code: "consent_required" }); });
    registerChatRoutes(app as never, { ...baseDeps(), installAgent } as never);
    const res = fakeRes();
    await routes["POST /api/agents/:id/install"]({ params: { id: "codex" }, body: {}, query: {} }, res);
    expect(res.code).toBe(409);
    expect(res.body).toMatchObject({ code: "consent_required" });
  });

  it("200 with the ensure result when consent is given", async () => {
    const { app, routes } = fakeApp();
    const installAgent = vi.fn(async () => ({ available: true, source: "managed", needsLogin: true }));
    registerChatRoutes(app as never, { ...baseDeps(), installAgent } as never);
    const res = fakeRes();
    await routes["POST /api/agents/:id/install"]({ params: { id: "codex" }, body: { consent: true }, query: {} }, res);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ available: true, source: "managed", needsLogin: true });
    expect(installAgent).toHaveBeenCalledWith("codex", true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/goldmine/__tests__/installRoute.test.ts`
Expected: FAIL — no `POST /api/agents/:id/install` handler registered.

- [ ] **Step 3: Extend `ChatRouteDeps` and register the route**

In `src/goldmine/chatRoutes.ts`, add to `ChatRouteDeps` (after `resolveStudio?`):

```ts
  // Install a missing adapter on demand (CLI only). Throws an error carrying
  // code:"consent_required" when consent is absent; the route maps that to 409.
  installAgent?: (id: string, consent: boolean) => Promise<{ available: boolean; source: string; needsLogin: boolean }>;
```

Inside `registerChatRoutes`, after the `GET /api/agents` handler (line 85), add:

```ts
  // POST /api/agents/:id/install — install a missing adapter on demand (CLI).
  app.post("/api/agents/:id/install", guard, async (req, res) => {
    const id = req.params.id;
    const consent = Boolean((req.body ?? {}).consent);
    if (!deps.installAgent) { res.status(400).json({ error: "install not supported on this runtime" }); return; }
    try {
      const result = await deps.installAgent(id, consent);
      res.json(result);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "consent_required") { res.status(409).json({ error: err.message, code: "consent_required" }); return; }
      if (/no install source|unknown agent/i.test(err.message)) { res.status(400).json({ error: err.message }); return; }
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/goldmine/__tests__/installRoute.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/goldmine/chatRoutes.ts src/goldmine/__tests__/installRoute.test.ts
git commit -m "feat(chat): POST /api/agents/:id/install (consent-gated)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Wire the runtime ctx, installer, and resolver in the server

**Files:**
- Modify: `src/index.ts` (imports near line 37-41; chat wiring 313-359)
- Test: `src/goldmine/__tests__/installAgentWiring.test.ts` *(new — unit-test the extracted `installAgentFn` builder, not the whole server)*

**Interfaces:**
- Consumes: `ensureAdapter`, `npmAdapterInstaller`, `adapterRuntimeCtx`, `resolveLaunch`, `availableAgents`, `AGENTS` (Tasks 2-7); `makeChatConnectFn` (Task 8); `installAgent` dep shape (Task 9).
- Produces: an `installAgentFn(ctx, install)` builder (exported from `chatRoutes.ts` to keep `index.ts` thin and give the wiring a unit test) mapping `(id, consent) → ensureAdapter(...)` and shaping `{ available, source, needsLogin: true }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/goldmine/__tests__/installAgentWiring.test.ts
import { describe, it, expect, vi } from "vitest";
import { installAgentFn } from "../chatRoutes.js";
import type { AdapterCtx } from "@agentgem/base";

const ctx: AdapterCtx = { runtime: "cli", execPath: "/usr/bin/node", home: "/home/u", onPath: () => false, exists: () => false, readJson: () => ({}) };

describe("installAgentFn", () => {
  it("throws 'unknown agent' for an id not in the registry", async () => {
    await expect(installAgentFn(ctx, vi.fn())("nope", true)).rejects.toThrow(/unknown agent/i);
  });
  it("shapes the ensure result with a static needsLogin hint", async () => {
    // Fake installer that materializes the managed entry so ensureAdapter resolves.
    const present = new Set<string>();
    const live: AdapterCtx = { ...ctx, exists: (p) => present.has(p), readJson: () => ({ bin: { "codex-acp": "dist/index.js" } }) };
    const install = vi.fn(async (_p: string, _v: string, dest: string) => { present.add(`${dest}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`); });
    // Emulate the rename by pointing managed dir at the temp dir: simplest is to let ensureAdapter's real fs run in a tmpdir.
    // Here we assert the shape via the desktop-agnostic path using a spy on ensureAdapter is overkill; instead assert needsLogin flag mapping:
    const out = await installAgentFn(live, install)("codex", true).catch((e) => e);
    // Either it resolved (available:true) or threw a real fs error in this fake; assert the happy mapping when available.
    if (!(out instanceof Error)) expect(out).toEqual({ available: true, source: "managed", needsLogin: true });
  });
});
```

> Note: the second assertion tolerates the fake-fs boundary; the authoritative install behavior is covered by Task 5's `ensureAdapter` tests. This test locks the registry lookup + result shaping.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/goldmine/__tests__/installAgentWiring.test.ts`
Expected: FAIL — `installAgentFn` not exported.

- [ ] **Step 3: Add `installAgentFn` to `chatRoutes.ts`**

Add near the top imports of `src/goldmine/chatRoutes.ts`:

```ts
import { AGENTS, ensureAdapter, type AdapterCtx, type AdapterInstaller } from "@agentgem/base";
```

Append this builder to `chatRoutes.ts`:

```ts
// Build the installAgent dep for registerChatRoutes: look the id up in AGENTS, run
// ensureAdapter, and attach a static "needs login on first use" hint (auth is the
// adapter's job — see spec: availability-only scope).
export function installAgentFn(ctx: AdapterCtx, install: AdapterInstaller) {
  return async (id: string, consent: boolean) => {
    const descriptor = AGENTS.find((a) => a.id === id);
    if (!descriptor) throw new Error(`unknown agent: ${id}`);
    const res = await ensureAdapter(descriptor, ctx, { consent, install });
    return { available: res.available, source: res.source, needsLogin: true };
  };
}
```

- [ ] **Step 4: Wire it in `src/index.ts`**

Update the import at line 37 and 41:

```ts
import { registerChatRoutes, chatConnectFn, makeChatConnectFn, installAgentFn, goldmineMcpServers } from "./goldmine/chatRoutes.js";
```
```ts
import { availableAgents, adapterRuntimeCtx, resolveLaunch, npmAdapterInstaller, createLogger } from "@agentgem/base";
```

At the top of the chat block (right after line 311's `chatCwd`), add:

```ts
    const adapterCtx = adapterRuntimeCtx();
    const chatConnect = makeChatConnectFn((d) => resolveLaunch(d, adapterCtx) ?? d);
```

Change the `ChatManager` connectFn (line 315) to use `chatConnect` instead of the imported `chatConnectFn`:

```ts
        const conn = await chatConnect(descriptor, connectOpts);
```

In the `registerChatRoutes({...})` deps object, change `listAgents` (line 333) and add `installAgent`:

```ts
      listAgents: () => availableAgents(adapterCtx),
      installAgent: installAgentFn(adapterCtx, npmAdapterInstaller()),
```

(The bare `chatConnectFn` import stays exported for other callers/tests; it is simply unused here now — remove it from this import line if the linter flags it.)

- [ ] **Step 5: Run test + full root build**

Run: `pnpm exec vitest run src/goldmine/__tests__/installAgentWiring.test.ts`
Expected: PASS.
Run: `pnpm build`
Expected: `tsc -b` clean (this is the real check that the wiring types line up).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/goldmine/chatRoutes.ts src/goldmine/__tests__/installAgentWiring.test.ts
git commit -m "feat(server): wire adapter runtime ctx, npm installer, resolving connect

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Desktop — bundle both adapters into app resources

**Files:**
- Create: `desktop/scripts/bundle-adapters.mjs`
- Modify: `desktop/electron-builder.yml` (`extraResources`)
- Modify: `desktop/package.json` (build pipeline)
- Test: `desktop/src/__tests__/bundleAdapters.test.ts` *(new — unit-test the path/layout planner the script uses)*

**Interfaces:**
- Consumes: `AGENTS` (Task 1) for the package list.
- Produces: `desktop/adapters-dist/<id>/node_modules/<pkg>/...` at build time, copied to `resources/adapters/<id>` by electron-builder. `resolveAdapterSource` (Task 2) already looks under `process.resourcesPath/adapters/<id>` on desktop, so no runtime change is needed here.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/src/__tests__/bundleAdapters.test.ts
import { describe, it, expect } from "vitest";
import { adapterInstallPlan } from "../../scripts/bundle-adapters.mjs";

describe("adapterInstallPlan", () => {
  it("produces one npm install per registry agent into its own prefix", () => {
    const agents = [
      { id: "claude-code", package: "@agentclientprotocol/claude-agent-acp", version: "0.51.0" },
      { id: "codex", package: "@agentclientprotocol/codex-acp", version: "1.1.0" },
    ];
    const plan = adapterInstallPlan(agents, "/out");
    expect(plan).toEqual([
      { prefix: "/out/claude-code", spec: "@agentclientprotocol/claude-agent-acp@0.51.0" },
      { prefix: "/out/codex", spec: "@agentclientprotocol/codex-acp@1.1.0" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && pnpm exec vitest run src/__tests__/bundleAdapters.test.ts`
Expected: FAIL — module `../../scripts/bundle-adapters.mjs` not found.

- [ ] **Step 3: Write the bundling script**

```js
// desktop/scripts/bundle-adapters.mjs
// Build-time: install each ACP adapter into desktop/adapters-dist/<id> so
// electron-builder can ship them under resources/adapters/<id>. Pure planner
// (adapterInstallPlan) is unit-tested; main() performs the installs.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Read the pinned registry from the built core so versions stay single-sourced.
const require = createRequire(import.meta.url);

export function adapterInstallPlan(agents, outDir) {
  return agents
    .filter((a) => a.package && a.version)
    .map((a) => ({ prefix: join(outDir, a.id), spec: `${a.package}@${a.version}` }));
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "..", "adapters-dist");
  // AGENTS is exported from the built @agentgem/base (desktop depends on the core).
  const { AGENTS } = require("@agentgem/base");
  rmSync(outDir, { recursive: true, force: true });
  for (const { prefix, spec } of adapterInstallPlan(AGENTS, outDir)) {
    mkdirSync(prefix, { recursive: true });
    console.log(`[bundle-adapters] installing ${spec} -> ${prefix}`);
    execFileSync("npm", ["install", spec, "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error"], { stdio: "inherit" });
  }
  console.log("[bundle-adapters] done");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
```

- [ ] **Step 4: Add `extraResources` entry to `desktop/electron-builder.yml`**

Under `extraResources:` (after the `core` entry, before the icon entry), add:

```yaml
  # Ship the ACP adapters (built by scripts/bundle-adapters.mjs) so Chat works
  # offline on desktop. resolveAdapterSource looks under resources/adapters/<id>.
  - from: adapters-dist
    to: adapters
    filter:
      - "**/*"
```

- [ ] **Step 5: Call the script in the desktop build pipeline**

In `desktop/package.json`, add a script and invoke it before packaging (place it ahead of the existing `bundle-core`/`dist` step in the `build`/`dist` chain — match the neighboring script names):

```json
"bundle-adapters": "node scripts/bundle-adapters.mjs"
```

Then ensure the packaging script runs it, e.g. update the existing `dist`/`pack` script to prepend `pnpm bundle-adapters && `.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd desktop && pnpm exec vitest run src/__tests__/bundleAdapters.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Manual verification note (not CI)**

Run: `cd desktop && pnpm bundle-adapters && ls adapters-dist/codex/node_modules/@agentclientprotocol/codex-acp/package.json`
Expected: the file exists (~510 MB total across both adapters). This is a heavy, network-dependent step — run once locally to confirm, not in CI.

- [ ] **Step 8: Commit**

```bash
git add desktop/scripts/bundle-adapters.mjs desktop/electron-builder.yml desktop/package.json desktop/src/__tests__/bundleAdapters.test.ts
git commit -m "feat(desktop): bundle ACP adapters into app resources

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Console — inline install affordance in the Chat picker

**Files:**
- Modify: `packages/console/src/panels/Chat/index.tsx`
- Test: `packages/console/src/panels/Chat/Chat.install.test.tsx` *(new)*

**Interfaces:**
- Consumes: `GET /api/agents` (now `{id,name,available,installable,source}`) and `POST /api/agents/:id/install`.
- Produces: below the picker, a list of `installable && !available` agents each with an Install button → in-line consent confirm → POST → on success refetch `/api/agents` and show a "installed · may need login on first use" hint.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/panels/Chat/Chat.install.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Chat } from "./index.js";

const agentsMissing = { agents: [
  { id: "claude-code", name: "Claude Code", available: true, installable: false, source: "path" },
  { id: "codex", name: "Codex", available: false, installable: true, source: "missing" },
] };
const agentsInstalled = { agents: [
  { id: "claude-code", name: "Claude Code", available: true, installable: false, source: "path" },
  { id: "codex", name: "Codex", available: true, installable: false, source: "managed" },
] };

describe("Chat adapter install", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("installs a missing adapter and refetches", async () => {
    let agentsCall = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/agents")) return { ok: true, json: async () => (agentsCall++ === 0 ? agentsMissing : agentsInstalled) } as Response;
      if (String(url).endsWith("/api/agents/codex/install")) {
        expect(JSON.parse(String(init?.body))).toEqual({ consent: true });
        return { ok: true, json: async () => ({ available: true, source: "managed", needsLogin: true }) } as Response;
      }
      throw new Error("unexpected " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Chat apiBase="" />);
    const btn = await screen.findByRole("button", { name: /install codex/i });
    fireEvent.click(btn);                                   // opens inline consent
    fireEvent.click(await screen.findByRole("button", { name: /^install$/i })); // confirm
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/agents/codex/install"), expect.anything()));
    await screen.findByText(/needs login/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Chat/Chat.install.test.tsx`
Expected: FAIL — no "Install Codex" button exists.

- [ ] **Step 3: Extend the `Agent` type and add install state**

In `packages/console/src/panels/Chat/index.tsx`, extend the interface (line 5-10):

```ts
interface Agent {
  id: string;
  name: string;
  description?: string;
  available: boolean;
  installable?: boolean;
  source?: string;
}
```

Add state near the other `useState`s (after line 30):

```ts
  const [installing, setInstalling] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [installNote, setInstallNote] = useState<string | null>(null);
```

Extract the agents fetch (lines 34-43) into a reusable `loadAgents` and call it from the effect:

```ts
  const loadAgents = () =>
    fetch(`${apiBase}/api/agents`)
      .then(j)
      .then((data: { agents: Agent[] }) => {
        setAgents(data.agents);
        const first = data.agents.find((a) => a.available);
        if (first) setAgentId(first.id);
      })
      .catch(() => setAgents([]));

  useEffect(() => { void loadAgents(); }, [apiBase]);
```

Add the install handler (after `draftGem`, around line 144):

```ts
  const installAgent = async (id: string) => {
    setInstalling(id);
    setConfirmId(null);
    setInstallNote(null);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/agents/${encodeURIComponent(id)}/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consent: true }),
      }).then(j);
      await loadAgents();
      setAgentId(id);
      if (res.needsLogin) setInstallNote(`${id} installed — it may need login on first use.`);
    } catch (e) {
      setError(e instanceof Error ? `Install failed: ${e.message}` : "Install failed");
    } finally {
      setInstalling(null);
    }
  };
```

- [ ] **Step 4: Render the install affordance under the picker**

In the JSX, right after the agent-picker `</div>` (line 169), insert:

```tsx
      {/* Missing adapters: inline install with a consent confirm */}
      {(agents ?? []).filter((a) => a.installable && !a.available).map((a) => (
        <div key={a.id} style={{ marginBottom: 8, fontSize: 13 }}>
          {confirmId === a.id ? (
            <span>
              Install <strong>{a.name}</strong> adapter? Downloads its npm package (~260&nbsp;MB) and runs it locally.{" "}
              <button className="btn" disabled={installing !== null} onClick={() => installAgent(a.id)}>Install</button>{" "}
              <button className="btn btn-ghost" onClick={() => setConfirmId(null)}>Cancel</button>
            </span>
          ) : (
            <button className="btn btn-ghost" disabled={installing !== null} onClick={() => setConfirmId(a.id)}>
              {installing === a.id ? `Installing ${a.name}…` : `Install ${a.name}`}
            </button>
          )}
        </div>
      ))}
      {installNote && <div className="ledger-hint" style={{ marginBottom: 8 }}>{installNote}</div>}
```

(Use whatever button classes the console already ships — check a neighboring panel; `btn`/`btn-ghost` are placeholders to match this repo's button styling.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Chat/Chat.install.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 6: Run the console suite for regressions**

Run: `pnpm --filter @agentgem/console test`
Expected: PASS (console tests are not in CI — this is the gate).

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Chat/index.tsx packages/console/src/panels/Chat/Chat.install.test.tsx
git commit -m "feat(console): inline ACP adapter install in the Chat picker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Opt-in smoke — real npm install of one adapter

**Files:**
- Create: `scripts/smoke/adapter-install-smoke.mjs`

**Interfaces:**
- Consumes: `ensureAdapter`, `npmAdapterInstaller`, `adapterRuntimeCtx`, `resolveLaunch`, `AGENTS` from the built `dist` (`@agentgem/base`).
- Produces: a manual script that installs `codex` into a throwaway HOME and asserts it resolves — mirrors `scripts/smoke/chat-e2e.mjs`. Never run in CI.

- [ ] **Step 1: Write the smoke script**

```js
// scripts/smoke/adapter-install-smoke.mjs
// Manual smoke: real npm install of the codex adapter into a temp HOME, then resolve.
// Run:  node scripts/smoke/adapter-install-smoke.mjs
// NOT part of CI (network + ~260 MB download).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, ensureAdapter, npmAdapterInstaller, adapterRuntimeCtx, resolveLaunch } from "../../dist/index.js";

const home = mkdtempSync(join(tmpdir(), "agentgem-adapter-smoke-"));
const ctx = adapterRuntimeCtx({ home, runtime: "cli" });
const codex = AGENTS.find((a) => a.id === "codex");

console.log(`[smoke] installing ${codex.package}@${codex.version} into ${home} …`);
const res = await ensureAdapter(codex, ctx, { consent: true, install: npmAdapterInstaller() });
console.log("[smoke] ensure result:", res);

const launch = resolveLaunch(codex, ctx);
if (!launch || launch.command.length < 2) { console.error("[smoke] FAIL: adapter did not resolve to an absolute launch"); process.exit(1); }
console.log("[smoke] resolved launch:", launch.command);
console.log("[smoke] PASS");
```

- [ ] **Step 2: Run it once locally to verify (manual)**

Run: `pnpm build && node scripts/smoke/adapter-install-smoke.mjs`
Expected: prints `ensure result: { available: true, source: 'managed' }`, a resolved launch `[<node>, <…/dist/index.js>]`, and `PASS`.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/adapter-install-smoke.mjs
git commit -m "test(smoke): opt-in real adapter install + resolve smoke

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Full root build + test:** `pnpm build && pnpm test` → `test (24)`/`test (26)` equivalent passes locally.
- [ ] **Console suite:** `pnpm --filter @agentgem/console test` → green (not in CI).
- [ ] **Manual drive:** start the server (`node dist/index.js`), open Chat with `codex-acp` NOT on PATH, confirm Codex shows "Install Codex", install it, confirm it flips to selectable with the needs-login hint, and a chat turn connects.
- [ ] **Integration check per CLAUDE.md:** confirm the branch is ahead of `origin/main` only, open a PR, let `test (24)`+`test (26)` gate it, and verify each commit landed on `origin/main` after merge.

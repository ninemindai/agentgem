# Eve run/deploy from the UI (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the rendered eve project locally (`eve build && eve start`) or deploy it to Vercel, driven from agentgem's UI, operating on a stable `.run/eve` dir per workspace.

**Architecture:** A new side-effecting module `src/gem/run.ts` (peer of `workspaces.ts`) with a dependency-injected `ProcessRunner` (so command/env/state logic is unit-testable without spawning), exposed via four controller endpoints and a "Run" section in `src/public/index.html`.

**Tech Stack:** TypeScript, pnpm, vitest, `node:child_process`; the eve CLI (already a dep of the rendered project) + the `vercel` CLI (added as an agentgem dep in Task 3).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-19-eve-run-deploy-design.md`.
- **Clean build before tests:** vitest runs compiled tests from `dist/`; `tsc -b` is incremental. Always `rm -rf dist *.tsbuildinfo && pnpm test`. Current suite is **133 tests / 18 files**.
- **Run dir:** `~/.agentgem/workspaces/<name>/.run/eve/` (dot-prefixed → auto-skipped by `readArchiveDir`, `archiveFs.ts:20`). Never `.targets/eve` (wiped by `renderTarget`).
- **Dependency injection:** all process spawning goes through the `ProcessRunner` interface; the real one (`realRunner`) wraps `node:child_process`. Tests use a fake runner — they MUST NOT spawn real processes.
- **`VERCEL_TOKEN`** is read from `process.env` server-side and never returned in any response.
- **Log ring buffer cap:** 200 lines.
- **One local run at a time** (single `eve start` port).
- Endpoints are local-only (spawn processes); do not add auth — out of scope.

---

### Task 1: `run.ts` foundations — interfaces, types, pure helpers, real runner

**Files:**
- Create: `src/gem/run.ts`
- Test: `src/gem/__tests__/run.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ProcessRunner`/`ProcHandle` interfaces; `RunMode`/`RunPhase`/`RunState` types; `pushLog(buf,line)`, `nodeMajor(version)`, `runReadiness()`, `parseEveUrl(lines)`, `parseVercelUrl(lines)`; `realRunner: ProcessRunner`.

- [ ] **Step 1: Write the failing tests**

Create `src/gem/__tests__/run.test.ts`:

```typescript
// src/gem/__tests__/run.test.ts
import { describe, it, expect } from "vitest";
import { pushLog, nodeMajor, parseEveUrl, parseVercelUrl } from "../run.js";

describe("run pure helpers", () => {
  it("pushLog caps the buffer at 200 lines (drops oldest)", () => {
    const buf: string[] = [];
    for (let i = 0; i < 250; i++) pushLog(buf, `line ${i}`);
    expect(buf.length).toBe(200);
    expect(buf[0]).toBe("line 50");
    expect(buf[199]).toBe("line 249");
  });

  it("nodeMajor parses the major version", () => {
    expect(nodeMajor("v24.13.0")).toBe(24);
    expect(nodeMajor("18.0.0")).toBe(18);
    expect(nodeMajor("garbage")).toBe(0);
  });

  it("parseEveUrl returns the first http(s) URL in the lines", () => {
    expect(parseEveUrl(["starting…", "Listening on http://127.0.0.1:3000"])).toBe("http://127.0.0.1:3000");
    expect(parseEveUrl(["no url here"])).toBeUndefined();
  });

  it("parseVercelUrl returns the deployment .vercel.app URL", () => {
    expect(parseVercelUrl(["Inspect: x", "https://gem-abc123.vercel.app"])).toBe("https://gem-abc123.vercel.app");
    expect(parseVercelUrl(["http://localhost:3000"])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- run`
Expected: FAIL — `../run.js` does not exist.

- [ ] **Step 3: Implement `src/gem/run.ts` (foundations only)**

```typescript
// src/gem/run.ts
// Run/deploy the rendered eve project. Side-effecting orchestration (peer of workspaces.ts).
// Process spawning is injected via ProcessRunner so command/env/state logic is unit-testable.
import { spawn as nodeSpawn } from "node:child_process";

export interface ProcHandle {
  onLine(cb: (line: string, stream: "out" | "err") => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}
export interface ProcessRunner {
  spawn(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ProcHandle;
}

export type RunMode = "local" | "vercel";
export type RunPhase = "idle" | "installing" | "building" | "running" | "deploying" | "failed";
export interface RunState { mode: RunMode; state: RunPhase; url?: string; logTail: string[] }

const LOG_CAP = 200;
export function pushLog(buf: string[], line: string): string[] {
  buf.push(line);
  if (buf.length > LOG_CAP) buf.splice(0, buf.length - LOG_CAP);
  return buf;
}
export function nodeMajor(version: string): number {
  const m = /^v?(\d+)/.exec(version);
  return m ? Number(m[1]) : 0;
}
export function runReadiness(): { local: boolean; vercel: boolean } {
  return { local: nodeMajor(process.version) >= 24, vercel: !!process.env.VERCEL_TOKEN };
}
// eve start prints a localhost URL once listening; grab the first http(s) URL.
export function parseEveUrl(lines: string[]): string | undefined {
  for (const l of lines) { const m = /(https?:\/\/[^\s]+)/.exec(l); if (m) return m[1]; }
  return undefined;
}
// vercel deploy prints the deployment URL (a bare https://<id>.vercel.app line).
export function parseVercelUrl(lines: string[]): string | undefined {
  for (const l of lines) { const m = /(https:\/\/[^\s]+\.vercel\.app[^\s]*)/.exec(l); if (m) return m[1]; }
  return undefined;
}

// Real runner: line-buffer stdout/stderr; deliver whole lines.
export const realRunner: ProcessRunner = {
  spawn(cmd, args, opts) {
    const child = nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    const lineCbs: ((line: string, s: "out" | "err") => void)[] = [];
    const exitCbs: ((code: number | null) => void)[] = [];
    const wire = (stream: NodeJS.ReadableStream | null, which: "out" | "err") => {
      if (!stream) return;
      let buf = "";
      stream.on("data", (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); lineCbs.forEach((cb) => cb(line, which)); }
      });
    };
    wire(child.stdout, "out");
    wire(child.stderr, "err");
    child.on("exit", (code) => exitCbs.forEach((cb) => cb(code)));
    child.on("error", () => exitCbs.forEach((cb) => cb(1)));
    return {
      onLine: (cb) => { lineCbs.push(cb); },
      onExit: (cb) => { exitCbs.push(cb); },
      kill: () => { child.kill(); },
    };
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- run`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/run.ts src/gem/__tests__/run.test.ts
git commit -m "feat(run): eve run module foundations — runner interface, helpers, readiness"
```

---

### Task 2: `ensureRunProject` + local run (start/stop/status)

**Files:**
- Modify: `src/gem/run.ts`
- Test: `src/gem/__tests__/run.test.ts`

**Interfaces:**
- Consumes: Task 1 types/helpers; `workspaceDir` (`./workspaces.js`), `readGemArchive` (`./archive.js`), `readArchiveDir`/`writeArchiveDir` (`./archiveFs.js`), `materialize` (`./targets.js`).
- Produces: `ensureRunProject(name, runner): Promise<string>`; `startLocal(name, runner?): Promise<RunState>`; `stopLocal(name): { stopped: boolean }`; `getRunStatus(name): RunState`.

- [ ] **Step 1: Write the failing tests**

Append to `src/gem/__tests__/run.test.ts`:

```typescript
import { startLocal, stopLocal, getRunStatus, type ProcessRunner, type ProcHandle } from "../run.js";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake runner that records spawns and lets the test drive lines/exit.
function fakeRunner() {
  const calls: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const handles: { lineCbs: Function[]; exitCbs: Function[]; killed: boolean }[] = [];
  const runner: ProcessRunner = {
    spawn(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
      const h = { lineCbs: [] as Function[], exitCbs: [] as Function[], killed: false };
      handles.push(h);
      const handle: ProcHandle = {
        onLine: (cb) => { h.lineCbs.push(cb); },
        onExit: (cb) => { h.exitCbs.push(cb); },
        kill: () => { h.killed = true; },
      };
      return handle;
    },
  };
  return { runner, calls, handles };
}

// A minimal workspace on disk: gem.json + the artifact files buildGem/materialize need.
function seedWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "agentgem-run-"));
  process.env.AGENTGEM_HOME = root;
  const ws = join(root, "workspaces", "gem");
  mkdirSync(join(ws, "skills", "review"), { recursive: true });
  writeFileSync(join(ws, "skills", "review", "SKILL.md"), "# body\n");
  // gem.json: a manifest readGemArchive accepts (one skill, no checks/secrets).
  writeFileSync(join(ws, "gem.json"), JSON.stringify({
    name: "gem", createdFrom: "/d",
    artifacts: [{ type: "skill", name: "review", source: "standalone", content: "# body\n" }],
    checks: [], requiredSecrets: [],
  }));
  return ws;
}

describe("local run", () => {
  it("startLocal installs, builds, then starts and parses the URL", async () => {
    seedWorkspace();
    const { runner, calls, handles } = fakeRunner();
    const p = startLocal("gem", runner);
    // 1st spawn = npm install; complete it
    await Promise.resolve();
    expect(calls[0].cmd).toBe("npm");
    expect(calls[0].args).toContain("install");
    handles[0].exitCbs.forEach((cb) => cb(0));
    await Promise.resolve();
    // 2nd spawn = eve build; complete it
    expect(calls[1].args).toContain("build");
    handles[1].exitCbs.forEach((cb) => cb(0));
    await Promise.resolve();
    // 3rd spawn = eve start; emit a URL line
    expect(calls[2].args).toContain("start");
    handles[2].lineCbs.forEach((cb) => cb("Listening on http://127.0.0.1:3000", "out"));
    const state = await p;
    expect(state.state).toBe("running");
    expect(state.url).toBe("http://127.0.0.1:3000");
    // stop kills the start child
    expect(stopLocal("gem").stopped).toBe(true);
    expect(handles[2].killed).toBe(true);
    expect(getRunStatus("gem").state).toBe("idle");
  });

  it("startLocal marks failed when eve build exits non-zero", async () => {
    seedWorkspace();
    const { runner, handles } = fakeRunner();
    const p = startLocal("gem", runner);
    await Promise.resolve(); handles[0].exitCbs.forEach((cb) => cb(0)); // install ok
    await Promise.resolve(); handles[1].exitCbs.forEach((cb) => cb(1)); // build fails
    const state = await p;
    expect(state.state).toBe("failed");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- run`
Expected: FAIL — `startLocal`/`stopLocal`/`getRunStatus` not exported.

- [ ] **Step 3: Implement `ensureRunProject` + local run in `src/gem/run.ts`**

Add imports at the top of `src/gem/run.ts`:

```typescript
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceDir } from "./workspaces.js";
import { readGemArchive } from "./archive.js";
import { readArchiveDir, writeArchiveDir } from "./archiveFs.js";
import { materialize } from "./targets.js";
```

Append to `src/gem/run.ts`:

```typescript
// Run one command to completion; pipe its lines into `log`; resolve with the exit code.
function runToEnd(runner: ProcessRunner, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string[]): Promise<number> {
  return new Promise((resolve) => {
    const h = runner.spawn(cmd, args, { cwd, env });
    h.onLine((line) => pushLog(log, line));
    h.onExit((code) => resolve(code ?? 0));
  });
}

// Re-render eve into a stable .run/eve dir (preserving node_modules) and npm-install when needed.
export async function ensureRunProject(name: string, runner: ProcessRunner, log: string[]): Promise<string> {
  const dir = workspaceDir(name);
  if (!existsSync(join(dir, "gem.json"))) throw new Error(`no workspace '${name}'`);
  const gem = readGemArchive(readArchiveDir(dir));
  const { files } = materialize(gem, "eve");
  const runDir = join(dir, ".run", "eve");
  rmSync(join(runDir, "agent"), { recursive: true, force: true }); // drop stale skills/connections
  mkdirSync(runDir, { recursive: true });
  writeArchiveDir(runDir, files); // writes agent/* + package.json + tsconfig + ignore files
  const pkg = readFileSync(join(runDir, "package.json"), "utf8");
  const marker = join(runDir, ".installed-package.json");
  const installed = existsSync(marker) ? readFileSync(marker, "utf8") : "";
  if (!existsSync(join(runDir, "node_modules")) || installed !== pkg) {
    const code = await runToEnd(runner, "npm", ["install", "--no-audit", "--no-fund"], runDir, process.env, log);
    if (code !== 0) throw new Error("npm install failed");
    writeFileSync(marker, pkg, "utf8");
  }
  return runDir;
}

const registry = new Map<string, { state: RunState; handle?: ProcHandle }>();
const EVE_BIN = (runDir: string) => join(runDir, "node_modules", ".bin", "eve");

export async function startLocal(name: string, runner: ProcessRunner = realRunner): Promise<RunState> {
  for (const e of registry.values()) {
    if (e.state.mode === "local" && e.state.state === "running") throw new Error("a local run is already active");
  }
  const state: RunState = { mode: "local", state: "installing", logTail: [] };
  registry.set(name, { state });
  try {
    const runDir = await ensureRunProject(name, runner, state.logTail);
    state.state = "building";
    const buildCode = await runToEnd(runner, EVE_BIN(runDir), ["build"], runDir, process.env, state.logTail);
    if (buildCode !== 0) { state.state = "failed"; return state; }
    const handle = runner.spawn(EVE_BIN(runDir), ["start"], { cwd: runDir, env: process.env });
    registry.set(name, { state, handle });
    state.state = "running";
    handle.onLine((line) => {
      pushLog(state.logTail, line);
      if (!state.url) { const u = parseEveUrl([line]); if (u) state.url = u; }
    });
    handle.onExit((code) => { if (state.state === "running") state.state = code === 0 ? "idle" : "failed"; });
    return state;
  } catch (err) {
    state.state = "failed";
    pushLog(state.logTail, err instanceof Error ? err.message : String(err));
    return state;
  }
}

export function stopLocal(name: string): { stopped: boolean } {
  const e = registry.get(name);
  if (!e?.handle) return { stopped: false };
  e.handle.kill();
  e.state.state = "idle";
  return { stopped: true };
}

export function getRunStatus(name: string): RunState {
  return registry.get(name)?.state ?? { mode: "local", state: "idle", logTail: [] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/run.ts src/gem/__tests__/run.test.ts
git commit -m "feat(run): ensureRunProject + local run (build, start, stop, status)"
```

---

### Task 3: Vercel deploy + add `vercel` dependency

**Files:**
- Modify: `package.json` (add `vercel` dep via `pnpm add`), `src/gem/run.ts`
- Test: `src/gem/__tests__/run.test.ts`

**Interfaces:**
- Consumes: Task 2 (`ensureRunProject`, `registry`, `runToEnd`, helpers).
- Produces: `deployVercel(name, runner?): Promise<RunState>`.

- [ ] **Step 1: Add the `vercel` dependency**

Run: `pnpm add vercel`
Expected: `vercel` appears under `dependencies` in `package.json`; lockfile updates.

- [ ] **Step 2: Write the failing tests**

Append to `src/gem/__tests__/run.test.ts`:

```typescript
import { deployVercel } from "../run.js";

describe("vercel deploy", () => {
  it("throws when VERCEL_TOKEN is unset", async () => {
    seedWorkspace();
    delete process.env.VERCEL_TOKEN;
    const { runner } = fakeRunner();
    await expect(deployVercel("gem", runner)).rejects.toThrow(/VERCEL_TOKEN/);
  });

  it("builds with VERCEL=1, then deploys with the token, and parses the URL", async () => {
    seedWorkspace();
    process.env.VERCEL_TOKEN = "tok_test";
    const { runner, calls, handles } = fakeRunner();
    const p = deployVercel("gem", runner);
    await Promise.resolve(); handles[0].exitCbs.forEach((cb) => cb(0)); // npm install
    await Promise.resolve();
    // eve build with VERCEL=1
    const build = calls[1];
    expect(build.args).toContain("build");
    expect(build.env.VERCEL).toBe("1");
    handles[1].exitCbs.forEach((cb) => cb(0));
    await Promise.resolve();
    // vercel deploy --prebuilt --yes --token=tok_test
    const deploy = calls[2];
    expect(deploy.args).toEqual(["deploy", "--prebuilt", "--yes", "--token=tok_test"]);
    handles[2].lineCbs.forEach((cb) => cb("https://gem-abc123.vercel.app", "out"));
    handles[2].exitCbs.forEach((cb) => cb(0));
    const state = await p;
    expect(state.mode).toBe("vercel");
    expect(state.state).toBe("idle");
    expect(state.url).toBe("https://gem-abc123.vercel.app");
    delete process.env.VERCEL_TOKEN;
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- run`
Expected: FAIL — `deployVercel` not exported.

- [ ] **Step 4: Implement `deployVercel` in `src/gem/run.ts`**

Add the vercel-bin resolver and the function (append to `src/gem/run.ts`):

```typescript
// agentgem's own pinned vercel CLI (installed as a dependency), run with cwd = the eve run dir.
const VERCEL_BIN = join(process.cwd(), "node_modules", ".bin", "vercel");

export async function deployVercel(name: string, runner: ProcessRunner = realRunner): Promise<RunState> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not set on the server — cannot deploy to Vercel.");
  const state: RunState = { mode: "vercel", state: "installing", logTail: [] };
  registry.set(name, { state });
  try {
    const runDir = await ensureRunProject(name, runner, state.logTail);
    state.state = "building";
    const buildCode = await runToEnd(runner, EVE_BIN(runDir), ["build"], runDir, { ...process.env, VERCEL: "1" }, state.logTail);
    if (buildCode !== 0) { state.state = "failed"; return state; }
    state.state = "deploying";
    const lines: string[] = [];
    const code = await new Promise<number>((resolve) => {
      const h = runner.spawn(VERCEL_BIN, ["deploy", "--prebuilt", "--yes", `--token=${token}`], { cwd: runDir, env: process.env });
      h.onLine((line) => { pushLog(state.logTail, line); lines.push(line); });
      h.onExit((c) => resolve(c ?? 0));
    });
    if (code !== 0) { state.state = "failed"; return state; }
    state.url = parseVercelUrl(lines);
    state.state = "idle";
    return state;
  } catch (err) {
    state.state = "failed";
    pushLog(state.logTail, err instanceof Error ? err.message : String(err));
    return state;
  }
}
```

- [ ] **Step 5: Run the tests + full suite**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- run` then `rm -rf dist *.tsbuildinfo && pnpm test`
Expected: PASS (full suite).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/gem/run.ts src/gem/__tests__/run.test.ts
git commit -m "feat(run): vercel deploy (eve build VERCEL=1 + pinned vercel deploy)"
```

---

### Task 4: Schemas + controller endpoints

**Files:**
- Modify: `src/schemas.ts`, `src/gem.controller.ts`
- Test: `src/__tests__/gem.controller.test.ts`

**Interfaces:**
- Consumes: `run.ts` (`runReadiness`, `startLocal`, `stopLocal`, `getRunStatus`, `deployVercel`).
- Produces: endpoints `GET /api/run-ready`, `POST /api/run`, `GET /api/run-status`, `POST /api/run/stop`.

- [ ] **Step 1: Add the schemas**

Append to `src/schemas.ts` (near the workspace schemas, after `DeleteWorkspaceResponseSchema` at line 301):

```typescript
export const RunReadyQuerySchema = z.object({ name: z.string(), target: TargetIdSchema });
export const RunReadyResponseSchema = z.object({ local: z.boolean(), vercel: z.boolean() });
export const RunRequestSchema = z.object({ name: z.string(), target: TargetIdSchema, mode: z.enum(["local", "vercel"]) });
export const RunStatusQuerySchema = z.object({ name: z.string(), target: TargetIdSchema });
export const RunStateSchema = z.object({
  mode: z.enum(["local", "vercel"]),
  state: z.enum(["idle", "installing", "building", "running", "deploying", "failed"]),
  url: z.string().optional(),
  logTail: z.array(z.string()),
});
export const RunStopRequestSchema = z.object({ name: z.string(), target: TargetIdSchema });
export const RunStopResponseSchema = z.object({ stopped: z.boolean() });
```

- [ ] **Step 2: Write the failing controller tests**

The file already sets up `supertest` as `client` (`client = supertest(...)`) against an `app` built in `beforeAll`. Use that existing `client` — do not introduce a `request`/`app` of your own. Add these inside the existing top-level `describe`:

```typescript
  it("GET /api/run-ready returns booleans", async () => {
    const res = await client.get("/api/run-ready").query({ name: "gem", target: "eve" });
    expect(res.status).toBe(200);
    expect(typeof res.body.local).toBe("boolean");
    expect(typeof res.body.vercel).toBe("boolean");
  });

  it("POST /api/run mode=vercel without VERCEL_TOKEN is rejected", async () => {
    delete process.env.VERCEL_TOKEN;
    const res = await client.post("/api/run").send({ name: "gem", target: "eve", mode: "vercel" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- gem.controller`
Expected: FAIL — routes 404.

- [ ] **Step 4: Implement the endpoints**

In `src/gem.controller.ts`, add to the imports from `./schemas.js`:
```typescript
  RunReadyQuerySchema, RunReadyResponseSchema, RunRequestSchema, RunStatusQuerySchema, RunStateSchema, RunStopRequestSchema, RunStopResponseSchema,
```
Add a new import line near the other `./gem/*` imports:
```typescript
import { runReadiness, startLocal, stopLocal, getRunStatus, deployVercel } from "./gem/run.js";
```

Add these handlers inside the `GemController` class (after the `renderWorkspace` handler):

```typescript
  // Whether the server is configured to run/deploy the rendered eve project. Booleans only.
  @get("/run-ready", { query: RunReadyQuerySchema, response: RunReadyResponseSchema })
  async runReady(_input: { query: z.infer<typeof RunReadyQuerySchema> }): Promise<z.infer<typeof RunReadyResponseSchema>> {
    return runReadiness();
  }

  // OUTWARD-FACING (local machine): run the rendered eve project locally or deploy it to Vercel.
  @post("/run", { body: RunRequestSchema, response: RunStateSchema })
  async run(input: { body: z.infer<typeof RunRequestSchema> }): Promise<z.infer<typeof RunStateSchema>> {
    const { name, mode } = input.body;
    const state = mode === "vercel" ? await deployVercel(name) : await startLocal(name);
    return state;
  }

  @get("/run-status", { query: RunStatusQuerySchema, response: RunStateSchema })
  async runStatus(input: { query: z.infer<typeof RunStatusQuerySchema> }): Promise<z.infer<typeof RunStateSchema>> {
    return getRunStatus(input.query.name);
  }

  @post("/run/stop", { body: RunStopRequestSchema, response: RunStopResponseSchema })
  async runStop(input: { body: z.infer<typeof RunStopRequestSchema> }): Promise<z.infer<typeof RunStopResponseSchema>> {
    return stopLocal(input.body.name);
  }
```

(`deployVercel` throws when `VERCEL_TOKEN` is unset; the framework surfaces a thrown handler error as a 4xx/5xx, satisfying the test's `>= 400` check. If the repo has an explicit request-validation/error convention that returns 400, follow it.)

- [ ] **Step 5: Run the tests + full suite**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- gem.controller` then `rm -rf dist *.tsbuildinfo && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(api): run-ready / run / run-status / run/stop endpoints"
```

---

### Task 5: UI "Run" section on the eve view

**Files:**
- Modify: `src/public/index.html`

**Interfaces:**
- Consumes: the Task 4 endpoints.
- Produces: a "Run" UI block with readiness-gated buttons, a state badge, a URL link, a polled log tail, and a Stop button.

- [ ] **Step 1: Add the Run UI markup + script**

In `src/public/index.html`, the workspace detail area renders target tabs via `#wsTargets` (around line 665) and `wsRender(t)` (the click handler at line 705). Add a Run panel that appears when the selected workspace target is `eve`. Add this markup just after the `#wsTargets` container's parent block:

```html
<div id="runPanel" style="display:none;margin-top:8px">
  <div class="bar">
    <strong style="flex:1">Run eve</strong>
    <button id="runLocal" class="ghost">▶ Run locally</button>
    <button id="runVercel" class="ghost">▲ Deploy to Vercel</button>
    <button id="runStop" class="ghost" style="display:none">■ Stop</button>
    <span class="d" id="runState" style="margin-left:8px"></span>
  </div>
  <div id="runUrl" style="margin:4px 0"></div>
  <pre id="runLog" style="max-height:200px;overflow:auto;background:#111;color:#ddd;padding:8px;font-size:12px"></pre>
</div>
```

Add this script before the closing `</script>` of the page:

```javascript
let __runWs = null, __runPoll = null;
async function runRefreshReady(name){
  const r = await (await fetch(`/api/run-ready?name=${encodeURIComponent(name)}&target=eve`)).json();
  const lb = document.getElementById("runLocal"), vb = document.getElementById("runVercel");
  lb.disabled = !r.local; lb.title = r.local ? "" : "needs Node 24+";
  vb.disabled = !r.vercel; vb.title = r.vercel ? "" : "set VERCEL_TOKEN on the server";
}
function runRenderState(s){
  document.getElementById("runState").textContent = s.state || "idle";
  document.getElementById("runStop").style.display = s.state === "running" ? "" : "none";
  document.getElementById("runUrl").innerHTML = s.url ? `<a href="${esc(s.url)}" target="_blank">${esc(s.url)}</a>` : "";
  document.getElementById("runLog").textContent = (s.logTail || []).join("\n");
}
function runStartPolling(name){
  if (__runPoll) clearInterval(__runPoll);
  __runPoll = setInterval(async () => {
    const s = await (await fetch(`/api/run-status?name=${encodeURIComponent(name)}&target=eve`)).json();
    runRenderState(s);
    if (!["installing","building","running","deploying"].includes(s.state)) { clearInterval(__runPoll); __runPoll = null; }
  }, 1500);
}
// Show the Run panel whenever a workspace's eve target is in view; call this from wsRender.
function runShowFor(name, target){
  __runWs = name;
  document.getElementById("runPanel").style.display = target === "eve" ? "" : "none";
  if (target === "eve") runRefreshReady(name);
}
document.getElementById("runLocal").addEventListener("click", async () => {
  const s = await (await fetch("/api/run", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ name: __runWs, target:"eve", mode:"local" }) })).json();
  runRenderState(s); runStartPolling(__runWs);
});
document.getElementById("runVercel").addEventListener("click", async () => {
  const s = await (await fetch("/api/run", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ name: __runWs, target:"eve", mode:"vercel" }) })).json();
  runRenderState(s); runStartPolling(__runWs);
});
document.getElementById("runStop").addEventListener("click", async () => {
  await fetch("/api/run/stop", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ name: __runWs, target:"eve" }) });
  runStartPolling(__runWs);
});
```

Then, in the existing `wsRender(t)` flow (and wherever a workspace is opened with a target), call `runShowFor(<workspaceName>, t)` so the panel toggles with the eve target. Use the same workspace-name variable the surrounding workspace code already holds (e.g. the value passed to `wsRender`/the open-workspace handler); do not invent a new source of the name.

- [ ] **Step 2: Verify the page builds and serves**

Run:
```bash
rm -rf dist *.tsbuildinfo && pnpm build
node dist/index.js & sleep 2
curl -s -o /dev/null -w "GET / -> %{http_code}\n" http://127.0.0.1:4317/
curl -s http://127.0.0.1:4317/ | grep -c 'id="runPanel"'
pkill -f "node dist/index.js"
```
Expected: `GET / -> 200` and the grep prints `1` (the build copies `index.html` into `dist/public`).

- [ ] **Step 3: Commit**

```bash
git add src/public/index.html
git commit -m "feat(ui): Run eve section — local/Vercel buttons, state, URL, log tail"
```

---

### Task 6: End-to-end verification (manual; controller)

Unit tests use a fake runner; this proves the real toolchain path. Manual, no commit.

- [ ] **Step 1: Build + start the server**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
rm -rf dist *.tsbuildinfo && pnpm build
node dist/index.js & sleep 2
```

- [ ] **Step 2: Ensure the `gem` workspace exists, then run locally**

```bash
curl -s -X POST http://127.0.0.1:4317/api/run \
  -H 'content-type: application/json' \
  -d '{"name":"gem","target":"eve","mode":"local"}' | head -c 400; echo
# poll until running + URL appears
for i in $(seq 1 40); do
  S=$(curl -s "http://127.0.0.1:4317/api/run-status?name=gem&target=eve")
  echo "$S" | grep -oE '"state":"[a-z]+"'; echo "$S" | grep -oE '"url":"[^"]+"' && break
  sleep 3
done
```
Expected: state progresses `installing`→`building`→`running` with a `url`. `curl` that URL's health/UI to confirm it serves, then `POST /api/run/stop`.

- [ ] **Step 3 (optional, needs a token): Vercel deploy**

```bash
pkill -f "node dist/index.js"
VERCEL_TOKEN=<your-token> node dist/index.js & sleep 2
curl -s -X POST http://127.0.0.1:4317/api/run \
  -H 'content-type: application/json' \
  -d '{"name":"gem","target":"eve","mode":"vercel"}' | head -c 400; echo
# poll run-status until state leaves "deploying"; expect a *.vercel.app url
```
Expected: a `*.vercel.app` deployment URL (the deployed agent needs `ANTHROPIC_API_KEY` configured on the Vercel project to actually answer — per the spec's v1 boundary).

- [ ] **Step 4: Stop the server**

```bash
pkill -f "node dist/index.js"
```

---

## Self-Review

**Spec coverage:**
- Stable `.run/eve` dir + install-skip heuristic (`.installed-package.json`) → Task 2 `ensureRunProject`. ✓
- Injected `ProcessRunner` for testability → Task 1 + used throughout. ✓
- Local run (build→start), stop, status, single-run guard, ring buffer → Task 2. ✓
- Vercel deploy (build `VERCEL=1` → pinned `vercel deploy --prebuilt --yes --token`), `vercel` dep added, throws without token → Task 3. ✓
- Polling status with `logTail`; endpoints `run-ready`/`run`/`run-status`/`run/stop` + schemas → Task 4. ✓
- UI Run section (readiness-gated buttons, badge, URL link, polled log, Stop) → Task 5. ✓
- Manual e2e (local + optional Vercel) → Task 6. ✓
- v1 boundaries (operator-set Vercel secrets, one local run, restart resets, local-only) honored: no secret-push code; single-run guard in `startLocal`; in-memory registry; no auth added. ✓

**Placeholder scan:** none — every code/test step has complete content. The two soft spots (the controller-test app/`request` setup in Task 4 Step 2, and the exact `wsRender` call site in Task 5 Step 1) instruct the implementer to mirror an existing, named pattern in the file rather than inventing one, because the surrounding harness/UI code is the source of truth — verify against it.

**Type consistency:** `RunState`/`RunPhase`/`RunMode`, `ProcessRunner`/`ProcHandle`, `ensureRunProject(name,runner,log)`, `startLocal`/`stopLocal`/`getRunStatus`/`deployVercel`, and `RunStateSchema` (mode/state/url/logTail) match across tasks and mirror the `run.ts` exports the controller imports.

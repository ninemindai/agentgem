# AgentCore Target — Phase 2 (deploy runner) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a workspace, deploy its rendered AgentCore project to AWS by shelling the `agentcore` CLI (`agentcore deploy`), with readiness gating (CLI present + AWS creds) and live log/state — via a **dedicated** AgentCore deploy surface (module + endpoints + UI), reusing the eve run module's proven primitives.

**Architecture:** New `src/gem/agentcoreRun.ts` peer of `run.ts`, importing run.ts's shared primitives (`ProcessRunner`, `RunPhase`, `pushLog`, `runToEnd`, `realRunner`). It re-renders the workspace's gem to the `agentcore` target into `.run/agentcore/`, then shells `agentcore deploy`. Process spawning is injected so tests use a fake runner (never a real CLI/AWS). Three dedicated endpoints expose readiness/deploy/status; the UI gains an AgentCore deploy section shown for `agentcore` workspaces.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), Vitest, supertest. No new runtime deps.

## Global Constraints

- ESM: every local import uses a `.js` suffix.
- Tests run via compiled dist: `npm run clean && npx tsc -b && npx vitest run`. Clean rebuild required after edits.
- **Never spawn real processes in tests** — use an injected fake `ProcessRunner` (the eve `run.test.ts` pattern). Tests never invoke a real `agentcore`/AWS.
- **Dedicated surface** (locked decision): do NOT overload eve's `/api/run*` endpoints or its `local`/`vercel` schemas. AgentCore gets its own module, schemas, and endpoints with AgentCore-shaped readiness `{ cli, awsCreds }`.
- Readiness is reported as **booleans only** (no secrets/paths leaked), mirroring `runReadiness`.
- Deploy operates on a **workspace** (`workspaceDir(name)`), like the eve runner — re-renders the gem to `agentcore`, never the live UI selection.
- **Host prerequisite (document, do not gate the build):** an actual `agentcore deploy` needs the `@aws/agentcore` CLI installed (preview channel) + AWS creds + CDK bootstrap, and depends on the emitted `agentcore.json` being schema-correct (Phase-1 open item: verify by running `agentcore create` once). The orchestration is fully built/tested with the fake runner regardless; real deploy is a separate manual validation (mirrors eve's microsandbox host-prereq note).

---

## File Structure

- **Modify** `src/gem/run.ts` — add `export` to the existing `runToEnd` so the new module reuses it (one-word change).
- **Create** `src/gem/agentcoreRun.ts` — `resolveAgentcoreBin`, `agentcoreReadiness`, `parseAgentcoreEndpoint`, `ensureAgentcoreProject`, `deployAgentcore`, `getAgentcoreStatus`, `AgentcoreDeployState`.
- **Create** `src/gem/__tests__/agentcoreRun.test.ts`.
- **Modify** `src/schemas.ts` — `AgentcoreReady*`, `AgentcoreDeploy*`, `AgentcoreDeployStateSchema`.
- **Modify** `src/gem.controller.ts` — `GET /api/agentcore/deploy-ready`, `POST /api/agentcore/deploy`, `GET /api/agentcore/deploy-status`.
- **Modify** `src/__tests__/gem.controller.test.ts` — endpoint tests.
- **Modify** `src/public/index.html` — AgentCore deploy section.

---

## Task 1: agentcoreRun module

**Files:**
- Modify: `src/gem/run.ts` (export `runToEnd`)
- Create: `src/gem/agentcoreRun.ts`
- Test: `src/gem/__tests__/agentcoreRun.test.ts`

**Interfaces:**
- Consumes (from `./run.js`): `pushLog`, `runToEnd`, `realRunner`, `type ProcessRunner`, `type RunPhase`; (from `./workspaces.js`) `workspaceDir`; (from `./archive.js`/`./archiveFs.js`) `readGemArchive`, `readArchiveDir`, `writeArchiveDir`; (from `./targets.js`) `materialize`.
- Produces:
  - `interface AgentcoreDeployState { state: RunPhase; url?: string; logTail: string[] }`
  - `resolveAgentcoreBin(): string | null`
  - `agentcoreReadiness(): { cli: boolean; awsCreds: boolean }`
  - `parseAgentcoreEndpoint(lines: string[]): string | undefined`
  - `ensureAgentcoreProject(name: string, runner: ProcessRunner, log: string[]): Promise<string>` (returns runDir)
  - `deployAgentcore(name: string, runner?: ProcessRunner): Promise<AgentcoreDeployState>`
  - `getAgentcoreStatus(name: string): AgentcoreDeployState`

- [ ] **Step 1: Export `runToEnd` from run.ts**

In `src/gem/run.ts`, change the `runToEnd` declaration (currently `function runToEnd(`) to:

```ts
export function runToEnd(runner: ProcessRunner, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string[]): Promise<number> {
```

- [ ] **Step 2: Write the failing test**

Create `src/gem/__tests__/agentcoreRun.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "../workspaces.js";
import type { Gem } from "../types.js";
import type { ProcessRunner, ProcHandle } from "../run.js";
import {
  resolveAgentcoreBin, agentcoreReadiness, parseAgentcoreEndpoint,
  deployAgentcore, getAgentcoreStatus,
} from "../agentcoreRun.js";

function fakeRunner() {
  const calls: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const handles: { lineCbs: Function[]; exitCbs: Function[]; killed: boolean }[] = [];
  const runner: ProcessRunner = {
    spawn(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
      const h = { lineCbs: [] as Function[], exitCbs: [] as Function[], killed: false };
      handles.push(h);
      const handle: ProcHandle = { onLine: (cb) => h.lineCbs.push(cb), onExit: (cb) => h.exitCbs.push(cb), kill: () => { h.killed = true; } };
      return handle;
    },
  };
  return { runner, calls, handles };
}
function seedWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "agentgem-ac-"));
  process.env.AGENTGEM_HOME = root;
  const gem: Gem = { name: "gem", createdFrom: "/d", artifacts: [{ type: "skill", name: "review", source: "standalone", content: "# body\n" }], checks: [], requiredSecrets: [] };
  createWorkspace("gem", gem);
  return join(root, "workspaces", "gem");
}
const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe("agentcore pure helpers", () => {
  it("agentcoreReadiness reports cli + awsCreds booleans from env", () => {
    delete process.env.AGENTCORE_BIN; delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_PROFILE;
    expect(agentcoreReadiness()).toEqual({ cli: false, awsCreds: false });
    process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    expect(agentcoreReadiness().awsCreds).toBe(true);
  });
  it("resolveAgentcoreBin honors AGENTCORE_BIN when the path exists", () => {
    process.env.AGENTCORE_BIN = "/usr/bin/env"; // a path that exists on the test host
    expect(resolveAgentcoreBin()).toBe("/usr/bin/env");
  });
  it("parseAgentcoreEndpoint prefers a harness ARN, falls back to a URL", () => {
    expect(parseAgentcoreEndpoint(["deploying…", "Created arn:aws:bedrock-agentcore:us-west-2:123:harness/Gem-Ab12"])).toMatch(/^arn:aws:bedrock-agentcore:.*harness\/Gem-Ab12$/);
    expect(parseAgentcoreEndpoint(["see https://x.example/console"])).toBe("https://x.example/console");
    expect(parseAgentcoreEndpoint(["nothing"])).toBeUndefined();
  });
});

describe("deployAgentcore", () => {
  it("rejects when AWS creds are missing", async () => {
    seedWorkspace();
    process.env.AGENTCORE_BIN = "/usr/bin/env";
    delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_PROFILE;
    const { runner } = fakeRunner();
    await expect(deployAgentcore("gem", runner)).rejects.toThrow(/AWS/);
  });

  it("shells `agentcore deploy` in .run/agentcore and parses the endpoint", async () => {
    seedWorkspace();
    process.env.AGENTCORE_BIN = "/usr/bin/env";
    process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    const { runner, calls, handles } = fakeRunner();
    const p = deployAgentcore("gem", runner);
    await Promise.resolve(); await Promise.resolve(); // let ensureAgentcoreProject (no spawn) + first spawn happen
    expect(calls[0].cmd).toBe("/usr/bin/env");
    expect(calls[0].args).toContain("deploy");
    expect(calls[0].cwd.endsWith(join(".run", "agentcore"))).toBe(true);
    handles[0].lineCbs.forEach((cb) => cb("Created arn:aws:bedrock-agentcore:us-west-2:123:harness/Gem-Ab12", "out"));
    handles[0].exitCbs.forEach((cb) => cb(0));
    const state = await p;
    expect(state.state).toBe("idle");
    expect(state.url).toMatch(/harness\/Gem-Ab12$/);
    expect(getAgentcoreStatus("gem").state).toBe("idle");
  });

  it("marks failed when the CLI exits non-zero", async () => {
    seedWorkspace();
    process.env.AGENTCORE_BIN = "/usr/bin/env"; process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    const { runner, handles } = fakeRunner();
    const p = deployAgentcore("gem", runner);
    await Promise.resolve(); await Promise.resolve();
    handles[0].exitCbs.forEach((cb) => cb(1));
    expect((await p).state).toBe("failed");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run agentcoreRun`
Expected: FAIL — `../agentcoreRun.js` not found.

- [ ] **Step 4: Write the implementation**

Create `src/gem/agentcoreRun.ts`:

```ts
// src/gem/agentcoreRun.ts
// Deploy a workspace's rendered AgentCore project via the `agentcore` CLI. Peer of run.ts;
// reuses its ProcessRunner injection so command/state logic is unit-testable without a real CLI/AWS.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { workspaceDir } from "./workspaces.js";
import { readGemArchive } from "./archive.js";
import { readArchiveDir, writeArchiveDir } from "./archiveFs.js";
import { materialize } from "./targets.js";
import { pushLog, runToEnd, realRunner, type ProcessRunner, type RunPhase } from "./run.js";

export interface AgentcoreDeployState { state: RunPhase; url?: string; logTail: string[] }

// Resolve the agentcore CLI: an explicit AGENTCORE_BIN, else the first `agentcore` on PATH.
export function resolveAgentcoreBin(): string | null {
  const explicit = process.env.AGENTCORE_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = join(dir, "agentcore");
    if (existsSync(p)) return p;
  }
  return null;
}

export function agentcoreReadiness(): { cli: boolean; awsCreds: boolean } {
  const hasId = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
  const hasRegion = !!(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION);
  return { cli: !!resolveAgentcoreBin(), awsCreds: hasId && hasRegion };
}

// `agentcore deploy` prints the created harness ARN (and/or a console URL). Prefer the ARN.
export function parseAgentcoreEndpoint(lines: string[]): string | undefined {
  for (const l of lines) {
    const arn = l.match(/arn:aws:bedrock-agentcore:[^\s"']+harness[^\s"']*/);
    if (arn) return arn[0];
  }
  for (const l of lines) {
    const u = l.match(/https?:\/\/[^\s"']+/);
    if (u) return u[0];
  }
  return undefined;
}

// Re-render the workspace's gem to the agentcore target into a stable .run/agentcore dir.
export async function ensureAgentcoreProject(name: string, _runner: ProcessRunner, _log: string[]): Promise<string> {
  const dir = workspaceDir(name);
  if (!existsSync(join(dir, "gem.json"))) throw new Error(`no workspace '${name}'`);
  const gem = readGemArchive(readArchiveDir(dir));
  const { files } = materialize(gem, "agentcore");
  const runDir = join(dir, ".run", "agentcore");
  rmSync(runDir, { recursive: true, force: true }); // drop stale renders
  mkdirSync(runDir, { recursive: true });
  writeArchiveDir(runDir, files);
  return runDir;
}

const registry = new Map<string, AgentcoreDeployState>();

export async function deployAgentcore(name: string, runner: ProcessRunner = realRunner): Promise<AgentcoreDeployState> {
  const bin = resolveAgentcoreBin();
  if (!bin) throw new Error("agentcore CLI not found — install `@aws/agentcore@preview` or set AGENTCORE_BIN.");
  if (!agentcoreReadiness().awsCreds) throw new Error("AWS credentials/region not configured (set AWS_PROFILE or AWS_ACCESS_KEY_ID + AWS_REGION).");
  const state: AgentcoreDeployState = { state: "deploying", logTail: [] };
  registry.set(name, state);
  try {
    const runDir = await ensureAgentcoreProject(name, runner, state.logTail);
    const code = await runToEnd(runner, bin, ["deploy"], runDir, process.env, state.logTail);
    if (code !== 0) { state.state = "failed"; return state; }
    state.url = parseAgentcoreEndpoint(state.logTail);
    state.state = "idle";
    return state;
  } catch (err) {
    state.state = "failed";
    pushLog(state.logTail, err instanceof Error ? err.message : String(err));
    return state;
  }
}

export function getAgentcoreStatus(name: string): AgentcoreDeployState {
  return registry.get(name) ?? { state: "idle", logTail: [] };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run clean && npx vitest run agentcoreRun`
Expected: PASS (all helper + deploy tests).

- [ ] **Step 6: Full suite + commit**

Run: `npx vitest run` (expect all pass — `runToEnd` export doesn't change behavior).

```bash
git add src/gem/run.ts src/gem/agentcoreRun.ts src/gem/__tests__/agentcoreRun.test.ts
git commit -m "feat(agentcore): deploy runner — agentcore CLI orchestration (readiness, deploy, status)"
```

---

## Task 2: controller endpoints + schemas

**Files:**
- Modify: `src/schemas.ts`
- Modify: `src/gem.controller.ts`
- Test: `src/__tests__/gem.controller.test.ts`

**Interfaces:**
- Consumes: `agentcoreReadiness`, `deployAgentcore`, `getAgentcoreStatus` from `./gem/agentcoreRun.js`.
- Produces:
  - `GET /api/agentcore/deploy-ready` → `{ cli: boolean, awsCreds: boolean }`
  - `POST /api/agentcore/deploy` body `{ name: string }` → `AgentcoreDeployState`
  - `GET /api/agentcore/deploy-status?name=` → `AgentcoreDeployState`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/gem.controller.test.ts`:

```ts
describe("agentcore deploy ops", () => {
  it("GET /api/agentcore/deploy-ready returns booleans", async () => {
    const r = await client.get("/api/agentcore/deploy-ready").expect(200);
    expect(typeof r.body.cli).toBe("boolean");
    expect(typeof r.body.awsCreds).toBe("boolean");
  });

  it("POST /api/agentcore/deploy without AWS creds is rejected", async () => {
    const savedP = process.env.AWS_PROFILE, savedK = process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_PROFILE; delete process.env.AWS_ACCESS_KEY_ID;
    process.env.AGENTCORE_BIN = "/usr/bin/env"; // CLI present so the failure is specifically the creds gate
    try {
      const res = await client.post("/api/agentcore/deploy").send({ name: "gem" });
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      if (savedP !== undefined) process.env.AWS_PROFILE = savedP;
      if (savedK !== undefined) process.env.AWS_ACCESS_KEY_ID = savedK;
      delete process.env.AGENTCORE_BIN;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run gem.controller`
Expected: FAIL — 404 on `/api/agentcore/deploy-ready`.

- [ ] **Step 3: Add schemas**

Append to `src/schemas.ts`:

```ts
// ── AgentCore deploy (Phase 2) ──
export const AgentcoreReadyResponseSchema = z.object({ cli: z.boolean(), awsCreds: z.boolean() });
export const AgentcoreDeployRequestSchema = z.object({ name: z.string() });
export const AgentcoreStatusQuerySchema = z.object({ name: z.string() });
export const AgentcoreDeployStateSchema = z.object({
  state: z.enum(["idle", "installing", "building", "running", "deploying", "failed"]),
  url: z.string().optional(),
  logTail: z.array(z.string()),
});
```

- [ ] **Step 4: Add endpoints**

In `src/gem.controller.ts`, add imports (merge into the existing import blocks):

```ts
import { agentcoreReadiness, deployAgentcore, getAgentcoreStatus } from "./gem/agentcoreRun.js";
import {
  AgentcoreReadyResponseSchema, AgentcoreDeployRequestSchema, AgentcoreStatusQuerySchema, AgentcoreDeployStateSchema,
} from "./schemas.js";
```

Add these methods inside `GemController` (the `PickQuerySchema` empty-query type is already imported and used by other GET endpoints):

```ts
  @get("/agentcore/deploy-ready", { query: PickQuerySchema, response: AgentcoreReadyResponseSchema })
  async agentcoreDeployReady(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof AgentcoreReadyResponseSchema>> {
    return agentcoreReadiness();
  }

  // OUTWARD-FACING: shells the agentcore CLI to deploy the workspace's rendered project to AWS.
  @post("/agentcore/deploy", { body: AgentcoreDeployRequestSchema, response: AgentcoreDeployStateSchema })
  async agentcoreDeploy(input: { body: z.infer<typeof AgentcoreDeployRequestSchema> }): Promise<z.infer<typeof AgentcoreDeployStateSchema>> {
    return deployAgentcore(input.body.name);
  }

  @get("/agentcore/deploy-status", { query: AgentcoreStatusQuerySchema, response: AgentcoreDeployStateSchema })
  async agentcoreDeployStatus(input: { query: z.infer<typeof AgentcoreStatusQuerySchema> }): Promise<z.infer<typeof AgentcoreDeployStateSchema>> {
    return getAgentcoreStatus(input.query.name);
  }
```

- [ ] **Step 5: Run test to verify it passes + full suite**

Run: `npm run clean && npx vitest run gem.controller` then `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(api): /agentcore/deploy-ready + /deploy + /deploy-status endpoints"
```

---

## Task 3: UI — AgentCore deploy section

**Files:**
- Modify: `src/public/index.html`

**Interfaces:**
- Consumes: `GET /api/agentcore/deploy-ready`, `POST /api/agentcore/deploy`, `GET /api/agentcore/deploy-status`. Uses the existing open-workspace name (`wsSelect.value`).

- [ ] **Step 1: Add the deploy section markup**

In `src/public/index.html`, just after the existing `<div id="runPanel" …>…</div>` block in the left pane (search for `id="runPanel"`), add:

```html
    <div id="acPanel" style="display:none;margin-top:8px">
      <div class="bar">
        <strong style="flex:1">Deploy to AWS (AgentCore)</strong>
        <button id="acDeploy" class="btn gem ghost">▲ Deploy</button>
        <span class="d" id="acState" style="margin-left:8px"></span>
      </div>
      <div id="acUrl" style="margin:4px 0"></div>
      <pre id="acLog" style="max-height:200px;overflow:auto;background:#111;color:#ddd;padding:8px;font-size:12px"></pre>
    </div>
```

- [ ] **Step 2: Wire the deploy logic**

Add to the `<script>` block (near the eve run wiring):

```js
let __acPoll = null;
function renderAcState(s){
  document.getElementById("acState").textContent = s.state || "";
  const urlEl = document.getElementById("acUrl");
  urlEl.innerHTML = s.url ? `<code>${esc(s.url)}</code>` : "";
  document.getElementById("acLog").textContent = (s.logTail || []).join("\n");
}
// Show the AgentCore deploy panel only when a workspace is open and the target is agentcore.
async function refreshAcPanel(){
  const panel = document.getElementById("acPanel");
  const ws = document.getElementById("wsSelect").value;
  const show = !!ws && document.getElementById("target").value === "agentcore";
  panel.style.display = show ? "" : "none";
  if (!show) return;
  const ready = await (await fetch("/api/agentcore/deploy-ready")).json();
  const btn = document.getElementById("acDeploy");
  btn.disabled = !(ready.cli && ready.awsCreds);
  btn.title = ready.cli && ready.awsCreds ? "" : `needs: ${!ready.cli ? "agentcore CLI " : ""}${!ready.awsCreds ? "AWS creds" : ""}`.trim();
}
document.getElementById("acDeploy").addEventListener("click", async () => {
  const name = document.getElementById("wsSelect").value; if (!name) return;
  const btn = document.getElementById("acDeploy"); btn.disabled = true;
  renderAcState({ state: "deploying", logTail: ["starting agentcore deploy…"] });
  const s = await (await fetch("/api/agentcore/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json();
  renderAcState(s); btn.disabled = false;
  clearInterval(__acPoll);
  if (s.state === "deploying") __acPoll = setInterval(async () => {
    const st = await (await fetch(`/api/agentcore/deploy-status?name=${encodeURIComponent(name)}`)).json();
    renderAcState(st); if (st.state !== "deploying") clearInterval(__acPoll);
  }, 2000);
});
document.getElementById("target").addEventListener("change", refreshAcPanel);
document.getElementById("wsSelect").addEventListener("change", refreshAcPanel);
```

Call `refreshAcPanel();` once after the workspace dropdown is first populated (add the call next to the existing run-panel refresh / at the end of the workspace-open handler `wsOpen`).

- [ ] **Step 3: Build + manual verify**

```bash
npm run build && PORT=4325 node dist/index.js &
```
```bash
browser-harness <<'PY'
import time
new_tab("http://127.0.0.1:4325/"); wait_for_load(); time.sleep(1.2)
print("acPanel present:", js("!!document.getElementById('acPanel')"))
print("ready endpoint:", js("(async()=>JSON.stringify(await (await fetch('/api/agentcore/deploy-ready')).json()))()"))
PY
```
Expected: `acPanel present: True`; the ready endpoint returns `{cli,awsCreds}` booleans. (Full deploy needs a real CLI + AWS creds — the panel's Deploy button is disabled with a tooltip when not ready; that gating is the observable behavior to confirm.) Stop the server with `kill %1` when done.

- [ ] **Step 4: Run unit suite + commit**

Run: `npm run clean && npx tsc -b && npx vitest run` (expect still-passing), then `npm run build`.

```bash
git add src/public/index.html
git commit -m "feat(ui): AgentCore deploy section (readiness-gated deploy + log tail)"
```

---

## Self-Review

**1. Spec coverage (spec §3 Phase 2):**
- New `src/gem/agentcoreRun.ts` mirroring the eve run module → Task 1. `agentcoreReadiness()→{cli,awsCreds}` → Task 1. `deployAgentcore` shells `agentcore deploy` in the rendered `.run/agentcore` dir, captures log+state → Task 1. status → Task 1. Dedicated endpoints (locked decision, supersedes spec's "generalize" suggestion) → Task 2. UI deploy section, readiness-gated → Task 3. Host-prereq/`agentcore.json` open item documented in Global Constraints. `invoke`/`stop` from the spec are deferred (deploy is the Phase-2 deliverable; invoke is a follow-up) — noted below.

**2. Placeholder scan:** No TBD/TODO. `/usr/bin/env` in tests is a real existing path used as a stand-in CLI binary (the fake runner never executes it). All code steps contain complete code.

**3. Type consistency:** `AgentcoreDeployState { state: RunPhase; url?; logTail }` defined in Task 1, serialized by `AgentcoreDeployStateSchema` (Task 2) with the same field names + the exact `RunPhase` enum members, and rendered by `renderAcState` (Task 3) reading `state`/`url`/`logTail`. `agentcoreReadiness(): {cli,awsCreds}` shape identical across Task 1 impl, Task 2 schema, Task 3 button-gate. Endpoint paths identical between Task 2 and the Task 3 fetches.

**Deferred (not in this plan, by design):** `agentcore invoke` (run a prompt against the deployed harness) and a stop/teardown control — Phase-2 ships deploy + status; invoke/teardown are a thin follow-up once a real deploy is validated against the confirmed `agentcore.json` schema.

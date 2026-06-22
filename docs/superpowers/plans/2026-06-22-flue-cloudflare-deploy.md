# Flue → Cloudflare One-Click Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a flue Gem one-click deployable to Cloudflare Workers from the Deploy tab, the same way eve deploys to Vercel.

**Architecture:** Rework the `flue` materialize target to emit a complete, deployable Cloudflare project (`src/` layout + `flue.config.ts` + `package.json` + `wrangler.jsonc`). Generalize `run.ts` (currently eve-only) to deploy any target, add a `deployCloudflare` path that runs `npm install → flue build → wrangler deploy` in `.run/flue`, and surface "Flue → Cloudflare (self-host)" in the Deploy-tab Backend dropdown (mirroring the eve panel).

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Zod, `@agentback/rest`, vitest + supertest, vanilla JS in `src/public/index.html`. The materialized flue project uses `@flue/runtime`, `valibot`, `agents@^0.14.1`, dev `@flue/cli` + `wrangler`.

## Global Constraints

- **ESM imports use `.js` specifiers** even for `.ts` sources (NodeNext). Copy verbatim.
- **Tests compile first:** `npm test` runs `tsc -b && vitest run` (vitest executes compiled `dist/`). After renames/deletes, if a stale-build error appears, run `rm -rf dist tsconfig.tsbuildinfo && npm test`.
- **`src/public/index.html` is not type-checked** and has no automated tests — verify by running the app (`pnpm run dev`).
- **Flue project recipe (validated against `@flue/cli@1.0.0-beta.1`):** source layout `src/agents/<kebab>.ts` (+ `src/skills/`, `src/connections/`, `src/proxies/`); `flue.config.ts` = `defineConfig({ target: 'cloudflare' })`; `package.json` has `"type":"module"`, deps `@flue/runtime`/`valibot`/`agents@^0.14.1`, devDeps `@flue/cli`/`wrangler`; `wrangler.jsonc` at project root with `name` (lowercase-kebab) + `compatibility_date` + `["nodejs_compat"]` + `migrations:[{tag:"v1",new_sqlite_classes:["FlueRegistry","Flue<Pascal(name)>Agent"]}]`. Deploy = `npm install` → `npx flue build --target cloudflare` → `npx wrangler deploy` (cwd = project), gated on `CLOUDFLARE_API_TOKEN`.
- **DO class naming:** flue generates `Flue<PascalCase(agent-file-basename)>Agent` (e.g. `hello.ts` → `FlueHelloAgent`). The `wrangler.jsonc` migration MUST list that exact class or deploy fails.
- **Secrets:** unchanged — flue connections reference `process.env[...]` by name; no secret values are emitted.

---

### Task 1: Rework the flue target to emit a deployable Cloudflare project

**Files:**
- Modify: `src/gem/targets.ts` (flue renderers + spec entry, ~lines 247-341, 507)
- Test: `src/gem/__tests__/targets.test.ts` (flue describe blocks, ~lines 122-200)

**Interfaces:**
- Consumes: `safePathSegment`, `rendered`, `escapeTemplate`, `flueConnection`, `stdioProxyRunner`, `PROXY_HOST`, `PROXY_BASE_PORT`, types `Gem`/`SkillArtifact`/`McpServerArtifact`/`InstructionsArtifact`/`MaterializeResult`/`FileTree`.
- Produces: helpers `flueName(s: string): string` (lowercase-kebab worker/file name) and `fluePascal(s: string): string` (PascalCase for the DO class); a flue-specific skill renderer `skillFlueMd`; `flueComposeAgent` now also emits `flue.config.ts`, `package.json`, `wrangler.jsonc`. `materialize(gem,"flue")` now produces the `src/` layout.

- [ ] **Step 1: Write the failing tests** — replace the three flue `describe` blocks (`flue target …`, `flue MCP connections`, `flue MCP wiring …`) in `src/gem/__tests__/targets.test.ts` with the `src/` paths plus new project-file assertions:

```typescript
describe("flue target (deployable cloudflare project)", () => {
  it("emits src/ layout, flue.config.ts, package.json, wrangler.jsonc with DO migration", () => {
    const p: Gem = { name: "my gem", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [
      skill("review", "# Review\nLook `here` and ${there}."),
      instr("soul", "be kind"),
      hook(),
    ] };
    const r = materialize(p, "flue");
    expect(r.files["src/skills/review/SKILL.md"]).toContain("# Review");
    const agent = r.files["src/agents/my-gem.ts"];
    expect(agent).toContain('import { createAgent');
    expect(agent).toContain('import skill0 from "../skills/review/SKILL.md" with { type: "skill" }');
    expect(agent).toContain("skills: [skill0]");
    expect(agent).toContain("be kind");
    expect(agent).toContain('model: "anthropic/claude-sonnet-4-6"');
    expect(agent).not.toContain("Look");
    // flue.config.ts
    expect(r.files["flue.config.ts"]).toContain('defineConfig({ target: "cloudflare" })');
    // package.json: type module + required deps
    const pkg = JSON.parse(r.files["package.json"]);
    expect(pkg.type).toBe("module");
    expect(pkg.name).toBe("my-gem");
    expect(pkg.dependencies).toMatchObject({ "@flue/runtime": expect.any(String), valibot: expect.any(String), agents: expect.any(String) });
    expect(pkg.devDependencies).toMatchObject({ "@flue/cli": expect.any(String), wrangler: expect.any(String) });
    // wrangler.jsonc: name + nodejs_compat + DO migration including the agent's class
    const wr = JSON.parse(r.files["wrangler.jsonc"]);
    expect(wr.name).toBe("my-gem");
    expect(wr.compatibility_flags).toContain("nodejs_compat");
    expect(wr.migrations[0].new_sqlite_classes).toEqual(expect.arrayContaining(["FlueRegistry", "FlueMyGemAgent"]));
    expect(r.skipped.map((s) => s.type)).toContain("hook");
  });

  it("compatibility includes a flue entry", () => {
    const p: Gem = { name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [skill("a")] };
    expect(compatibility(p).flue).toBeTruthy();
  });
});

describe("flue MCP connections (src/ layout)", () => {
  it("http server -> a connectMcpServer connection with env auth, no secret value", () => {
    const r = materialize({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [httpMcp("ctx")] }, "flue");
    const c = r.files["src/connections/ctx.ts"];
    expect(c).toContain('import { connectMcpServer } from "@flue/runtime"');
    expect(c).toContain('connectMcpServer("ctx"');
    expect(c).toContain("https://mcp.x/sse");
    expect(c).toContain('process.env["X_TOKEN"]');
    expect(JSON.stringify(r.files)).not.toContain("secret-value");
  });

  it("sse server -> transport: \"sse\"", () => {
    const sse: McpServerArtifact = { type: "mcp_server", name: "leg", transport: "sse", config: { url: "https://leg/sse" } };
    const r = materialize({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [sse] }, "flue");
    expect(r.files["src/connections/leg.ts"]).toContain('transport: "sse"');
  });

  it("stdio server -> a proxy runner plus a localhost connection", () => {
    const r = materialize({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [mcp("gh")] }, "flue");
    expect(r.files["src/proxies/gh.mjs"]).toBeTruthy();
    expect(r.files["src/connections/gh.ts"]).toContain("http://127.0.0.1:");
    expect(r.files["src/connections/gh.ts"]).toContain("/mcp");
    expect(r.skipped).toEqual([]);
  });
});

describe("flue MCP wiring (connections reach the agent)", () => {
  it("imports each emitted connection and awaits its tools into the agent (async initializer)", () => {
    const r = materialize({ name: "my gem", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [
      skill("review"), httpMcp("ctx"), mcp("gh"),
    ] }, "flue");
    const agent = r.files["src/agents/my-gem.ts"];
    expect(agent).toContain('import conn0 from "../connections/ctx.ts"');
    expect(agent).toContain('import conn1 from "../connections/gh.ts"');
    expect(agent).toContain("await Promise.all([conn0(), conn1()])");
    expect(agent).toContain("tools: connections.flatMap((c) => c.tools)");
  });
});
```

(Keep the existing closing braces / any trailing describe blocks after these intact.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- targets`
Expected: FAIL — files at `src/skills/...`, `src/agents/my-gem.ts`, `package.json`, `wrangler.jsonc` are `undefined` (target still emits old root layout).

- [ ] **Step 3: Add the flue name helpers + skill renderer** — in `src/gem/targets.ts`, after `eveSegment` (line ~36) add:

```typescript
// Flue worker + agent-file name: lower-kebab, alphanumeric+dashes only (Cloudflare worker name rules).
const flueName = (name: string): string => {
  const s = name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length ? s : "agent";
};
// PascalCase of the kebab name; flue derives the Durable Object class as `Flue<Pascal>Agent`.
const fluePascal = (name: string): string =>
  flueName(name).split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("") || "Agent";
// Flue skills live under src/ (the agent file is src/agents/<name>.ts and imports ../skills/...).
const skillFlueMd = (a: SkillArtifact): FileTree => ({ [`src/skills/${safePathSegment(a.name)}/SKILL.md`]: a.content });
```

- [ ] **Step 4: Move flue connection files under `src/`** — in `flueConnectionFiles` (line ~273), change the two emitted paths:

```typescript
    const connectionPath = `src/connections/${seg}.ts`;
```
and (line ~292):
```typescript
      files[`src/proxies/${seg}.mjs`] = stdioProxyRunner(s.name, s.config.command, args, (s.secretRefs ?? []).map((r) => r.name), p);
```

(The agent's import strings `../skills/...` and `../connections/...` already resolve correctly from `src/agents/`, so they stay unchanged.)

- [ ] **Step 5: Emit the deployable project from compose** — replace the final `return` of `flueComposeAgent` (line ~341, `return rendered({ [\`agents/${safePathSegment(gem.name)}.ts\`]: file });`) with:

```typescript
  const wname = flueName(gem.name);
  const doClass = `Flue${fluePascal(gem.name)}Agent`;
  const flueConfig = `import { defineConfig } from "@flue/cli/config";\nexport default defineConfig({ target: "cloudflare" });\n`;
  const pkg = JSON.stringify({
    name: wname, version: "0.1.0", private: true, type: "module",
    scripts: { build: "flue build --target cloudflare", deploy: "wrangler deploy" },
    dependencies: { "@flue/runtime": "^1.0.0-beta.2", valibot: "^1", agents: "^0.14.1" },
    devDependencies: { "@flue/cli": "^1.0.0-beta.1", wrangler: "^4" },
  }, null, 2) + "\n";
  const wrangler = JSON.stringify({
    name: wname,
    compatibility_date: "2026-06-01",
    compatibility_flags: ["nodejs_compat"],
    migrations: [{ tag: "v1", new_sqlite_classes: ["FlueRegistry", doClass] }],
  }, null, 2) + "\n";
  return rendered({
    [`src/agents/${wname}.ts`]: file,
    "flue.config.ts": flueConfig,
    "package.json": pkg,
    "wrangler.jsonc": wrangler,
  });
```

- [ ] **Step 6: Point the flue spec at the flue skill renderer** — change the flue registry entry (line ~507) from `skill: skillSkillMd` to `skill: skillFlueMd`:

```typescript
  flue:   { id: "flue",   label: "Flue",   skill: skillFlueMd,        instructions: () => ({}), mcp: mcpFlueConnections, compose: flueComposeAgent },
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- targets`
Expected: PASS (all flue blocks green; other targets unaffected).

- [ ] **Step 8: Commit**

```bash
git add src/gem/targets.ts src/gem/__tests__/targets.test.ts
git commit -m "feat(targets): flue emits a deployable Cloudflare project (src/ layout + config/package/wrangler)"
```

---

### Task 2: Generalize run.ts for target-aware deploy + add Cloudflare path

**Files:**
- Modify: `src/gem/run.ts`
- Test: `src/gem/__tests__/run.test.ts`

**Interfaces:**
- Consumes: `materialize` (now flue-deployable), `workspaceDir`, `readGemArchive`, `readArchiveDir`, `writeArchiveDir`, `ProcessRunner`/`runToEnd`/`pushLog`.
- Produces:
  - `RunMode` extended to `"local" | "vercel" | "cloudflare"`.
  - `runReadiness(): { local: boolean; vercel: boolean; cloudflare: boolean }` (cloudflare = `!!process.env.CLOUDFLARE_API_TOKEN`).
  - `ensureRunProject(name: string, target: TargetId, runner, log): Promise<string>` (target-parameterized; runDir `.run/<target>`).
  - `deployCloudflare(name: string, runner?): Promise<RunState>`.
  - `getRunStatus(name: string, target: string): RunState` and `stopLocal(name: string, target: string)` now key by `${name}:${target}`. `startLocal`/`deployVercel` register under `${name}:eve`; `deployCloudflare` under `${name}:flue`.
  - `parseWorkersUrl(lines: string[]): string | undefined`.

- [ ] **Step 1: Write the failing tests** — add to `src/gem/__tests__/run.test.ts` (reuse its existing fake `ProcessRunner` helper; check the file's top for the helper name — below assumes `fakeRunner(scripted)` mirroring the eve tests; adapt to the actual helper):

```typescript
import { deployCloudflare, runReadiness, parseWorkersUrl } from "../run.js";

describe("parseWorkersUrl", () => {
  it("grabs the workers.dev URL from wrangler output", () => {
    expect(parseWorkersUrl(["Uploaded", "https://my-gem.acct.workers.dev", "Done"]))
      .toBe("https://my-gem.acct.workers.dev");
  });
});

describe("runReadiness cloudflare gate", () => {
  it("reports cloudflare true only when CLOUDFLARE_API_TOKEN is set", () => {
    const prev = process.env.CLOUDFLARE_API_TOKEN;
    try {
      delete process.env.CLOUDFLARE_API_TOKEN;
      expect(runReadiness().cloudflare).toBe(false);
      process.env.CLOUDFLARE_API_TOKEN = "t";
      expect(runReadiness().cloudflare).toBe(true);
    } finally { if (prev !== undefined) process.env.CLOUDFLARE_API_TOKEN = prev; else delete process.env.CLOUDFLARE_API_TOKEN; }
  });
});

describe("deployCloudflare", () => {
  it("fails fast without CLOUDFLARE_API_TOKEN", async () => {
    const prev = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    try {
      await expect(deployCloudflare("nope")).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    } finally { if (prev !== undefined) process.env.CLOUDFLARE_API_TOKEN = prev; }
  });
});
```

Note: model the happy-path deploy test on the **existing `deployVercel` test** in this file — copy its workspace-setup + fake-runner scaffolding, set `CLOUDFLARE_API_TOKEN`, script success exit codes for `flue build` + `wrangler deploy`, and assert `state.mode === "cloudflare"`, `state.state === "idle"`, and `state.url` parsed from a scripted `https://*.workers.dev` line. If the existing eve tests assert `getRunStatus(name)` with one arg, update those call sites to `getRunStatus(name, "eve")`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- run`
Expected: FAIL — `deployCloudflare`/`parseWorkersUrl` not exported; `runReadiness().cloudflare` undefined.

- [ ] **Step 3: Extend types + readiness + URL parser** — in `src/gem/run.ts`:

Add the `TargetId` import (line ~10 area): `import { materialize, type TargetId } from "./targets.js";`

Change line 21:
```typescript
export type RunMode = "local" | "vercel" | "cloudflare";
```
Change `runReadiness` (line 35):
```typescript
export function runReadiness(): { local: boolean; vercel: boolean; cloudflare: boolean } {
  return { local: nodeMajor(process.version) >= 24, vercel: !!process.env.VERCEL_TOKEN, cloudflare: !!process.env.CLOUDFLARE_API_TOKEN };
}
```
Add after `parseVercelUrl` (line 47):
```typescript
// wrangler prints the deployed Worker URL (https://<name>.<acct>.workers.dev).
export function parseWorkersUrl(lines: string[]): string | undefined {
  for (const l of lines) { const m = /(https:\/\/[^\s]+\.workers\.dev[^\s]*)/.exec(l); if (m) return m[1]; }
  return undefined;
}
```

- [ ] **Step 4: Generalize `ensureRunProject` + registry keying** — replace `ensureRunProject` (lines 86-104) with a target-parameterized version that cleans everything except `node_modules`/marker:

```typescript
// Re-render <target> into a stable .run/<target> dir (preserving node_modules) and npm-install when needed.
export async function ensureRunProject(name: string, target: TargetId, runner: ProcessRunner, log: string[]): Promise<string> {
  const dir = workspaceDir(name);
  if (!existsSync(join(dir, "gem.json"))) throw new Error(`no workspace '${name}'`);
  const gem = readGemArchive(readArchiveDir(dir));
  const { files } = materialize(gem, target);
  const runDir = join(dir, ".run", target);
  mkdirSync(runDir, { recursive: true });
  // Drop stale rendered sources + build caches; keep node_modules + the install marker.
  for (const entry of readdirSync(runDir)) {
    if (entry === "node_modules" || entry === ".installed-package.json") continue;
    rmSync(join(runDir, entry), { recursive: true, force: true });
  }
  writeArchiveDir(runDir, files);
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
```

Add `readdirSync` to the `node:fs` import on line 5: `import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";`

Update the two existing `ensureRunProject(name, runner, ...)` call sites (in `startLocal` line ~116 and `deployVercel` line ~157) to pass the eve target: `ensureRunProject(name, "eve", runner, state.logTail)`.

- [ ] **Step 5: Key the registry by name+target; thread target through status/stop** — change the registry key everywhere:

In `startLocal` (line 114, 121): `registry.set(\`${name}:eve\`, { state })` / `registry.set(\`${name}:eve\`, { state, handle })`. Also update the "already active" guard loop to check `e.state.mode === "local"` (unchanged).
In `deployVercel` (line 155): `registry.set(\`${name}:eve\`, { state })`.
Replace `stopLocal` (line 136) and `getRunStatus` (line 144):
```typescript
export function stopLocal(name: string, target: string): { stopped: boolean } {
  const e = registry.get(`${name}:${target}`);
  if (!e?.handle) return { stopped: false };
  e.handle.kill();
  e.state.state = "idle";
  return { stopped: true };
}

export function getRunStatus(name: string, target: string): RunState {
  return registry.get(`${name}:${target}`)?.state ?? { mode: "local", state: "idle", logTail: [] };
}
```

- [ ] **Step 6: Add `deployCloudflare`** — append after `deployVercel`:

```typescript
const binIn = (runDir: string, name: string) => join(runDir, "node_modules", ".bin", name);

export async function deployCloudflare(name: string, runner: ProcessRunner = realRunner): Promise<RunState> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set on the server — cannot deploy to Cloudflare.");
  const state: RunState = { mode: "cloudflare", state: "installing", logTail: [] };
  registry.set(`${name}:flue`, { state });
  try {
    const runDir = await ensureRunProject(name, "flue", runner, state.logTail);
    state.state = "building";
    const buildCode = await runToEnd(runner, binIn(runDir, "flue"), ["build", "--target", "cloudflare"], runDir, process.env, state.logTail);
    if (buildCode !== 0) { state.state = "failed"; return state; }
    state.state = "deploying";
    const lines: string[] = [];
    const env = { ...process.env, CLOUDFLARE_API_TOKEN: token };
    const code = await new Promise<number>((resolve) => {
      const h = runner.spawn(binIn(runDir, "wrangler"), ["deploy"], { cwd: runDir, env });
      h.onLine((line) => { pushLog(state.logTail, line); lines.push(line); });
      h.onExit((c) => resolve(c ?? 0));
    });
    if (code !== 0) { state.state = "failed"; return state; }
    state.url = parseWorkersUrl(lines);
    state.state = "idle";
    return state;
  } catch (err) {
    state.state = "failed";
    pushLog(state.logTail, err instanceof Error ? err.message : String(err));
    return state;
  }
}
```

(`EVE_BIN` may now be redundant with `binIn`; leave `EVE_BIN` as-is to keep the eve path untouched, or switch `startLocal`/`deployVercel` to `binIn(runDir,"eve")` — either is fine. Do NOT change eve behavior beyond the `ensureRunProject` target arg + registry key.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `rm -rf dist tsconfig.tsbuildinfo && npm test -- run`
Expected: PASS — new cloudflare tests green; existing eve `run` tests still pass (with `getRunStatus`/`stopLocal` two-arg updates).

- [ ] **Step 8: Commit**

```bash
git add src/gem/run.ts src/gem/__tests__/run.test.ts
git commit -m "feat(run): target-aware ensureRunProject + deployCloudflare (flue -> Cloudflare via wrangler)"
```

---

### Task 3: Wire schemas + controller for the cloudflare run mode

**Files:**
- Modify: `src/schemas.ts` (RunRequest/RunState/RunReady, ~lines 316-327)
- Modify: `src/gem.controller.ts` (run import + handlers, ~lines 42, 136-157)
- Test: `src/__tests__/gem.controller.test.ts`

**Interfaces:**
- Consumes: `deployCloudflare`, `runReadiness`/`getRunStatus`/`stopLocal` (new signatures) from Task 2.
- Produces: `/api/run` accepts `mode:"cloudflare"`; `/api/run-ready` returns `{local,vercel,cloudflare}`; `/api/run-status` + `/api/run/stop` pass `target` through.

- [ ] **Step 1: Write the failing test** — add to `src/__tests__/gem.controller.test.ts` (the file already sets an isolated `AGENTGEM_HOME` in beforeAll):

```typescript
  it("run-ready reports the cloudflare gate", async () => {
    const prev = process.env.CLOUDFLARE_API_TOKEN;
    try {
      process.env.CLOUDFLARE_API_TOKEN = "t";
      const r = await client.get(`/api/run-ready?name=x&target=flue`).expect(200);
      expect(r.body.cloudflare).toBe(true);
    } finally { if (prev !== undefined) process.env.CLOUDFLARE_API_TOKEN = prev; else delete process.env.CLOUDFLARE_API_TOKEN; }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- gem.controller`
Expected: FAIL — response has no `cloudflare` key (schema strips it) / 200 body mismatch.

- [ ] **Step 3: Update schemas** — in `src/schemas.ts`:

```typescript
export const RunReadyResponseSchema = z.object({ local: z.boolean(), vercel: z.boolean(), cloudflare: z.boolean() });
export const RunRequestSchema = z.object({ name: z.string(), target: TargetIdSchema, mode: z.enum(["local", "vercel", "cloudflare"]) });
export const RunStateSchema = z.object({
  mode: z.enum(["local", "vercel", "cloudflare"]),
  state: z.enum(["idle", "installing", "building", "running", "deploying", "failed"]),
  url: z.string().optional(),
  logTail: z.array(z.string()),
});
```

- [ ] **Step 4: Update the controller** — in `src/gem.controller.ts`:

Import (line 42): `import { runReadiness, startLocal, stopLocal, getRunStatus, deployVercel, deployCloudflare } from "./gem/run.js";`

Replace the `run`, `runStatus`, `runStop` handlers (lines 142-157):
```typescript
  @post("/run", { body: RunRequestSchema, response: RunStateSchema })
  async run(input: { body: z.infer<typeof RunRequestSchema> }): Promise<z.infer<typeof RunStateSchema>> {
    const { name, mode } = input.body;
    const state = mode === "vercel" ? await deployVercel(name)
      : mode === "cloudflare" ? await deployCloudflare(name)
      : await startLocal(name);
    return state;
  }

  @get("/run-status", { query: RunStatusQuerySchema, response: RunStateSchema })
  async runStatus(input: { query: z.infer<typeof RunStatusQuerySchema> }): Promise<z.infer<typeof RunStateSchema>> {
    return getRunStatus(input.query.name, input.query.target);
  }

  @post("/run/stop", { body: RunStopRequestSchema, response: RunStopResponseSchema })
  async runStop(input: { body: z.infer<typeof RunStopRequestSchema> }): Promise<z.infer<typeof RunStopResponseSchema>> {
    return stopLocal(input.body.name, input.body.target);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `rm -rf dist tsconfig.tsbuildinfo && npm test`
Expected: PASS — full suite green (run-ready cloudflare test passes; eve run-status/stop still work).

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(api): run endpoints accept cloudflare mode + target-scoped status/stop; run-ready reports cloudflare"
```

---

### Task 4: Surface "Flue → Cloudflare" in the Deploy tab

**Files:**
- Modify: `src/public/index.html` (renderPublish backend dropdown + a flue deploy panel, near the eve panel added earlier)

**Interfaces:**
- Consumes: `/api/run-ready?...&target=flue` (`.cloudflare`), `/api/run` (`mode:"cloudflare"`), `/api/run-status?...&target=flue`. Existing `wsCurrent`, `esc`, `attachDeployTargetListener`, `eveRunning`.
- Produces: a `flue-cloudflare` backend option + `renderFlueDeploy`/`flueDeploy`/`flueRenderRun`/`fluePollRun` (mirrors the eve functions).

- [ ] **Step 1: Add the backend option + branch** — in `renderPublish`, extend the `targetOpts` append (where the `eve-vercel` option was added) and add a branch next to the eve one:

```javascript
  const targetOpts = targets.map(t => `<option value="${esc(t.id)}" ${t.id === selectedTarget ? "selected" : ""}>${esc(t.label || t.id)}</option>`).join("")
    + `<option value="eve-vercel" ${selectedTarget === "eve-vercel" ? "selected" : ""}>Eve → Vercel (self-host)</option>`
    + `<option value="flue-cloudflare" ${selectedTarget === "flue-cloudflare" ? "selected" : ""}>Flue → Cloudflare (self-host)</option>`;
```
and after the eve branch line `if (selectedTarget === "eve-vercel") { await renderEveDeploy(el, selHtml); return; }` add:
```javascript
  if (selectedTarget === "flue-cloudflare") { await renderFlueDeploy(el, selHtml); return; }
```

- [ ] **Step 2: Add the flue deploy panel + polling** — after the eve deploy functions (`evePollRun`), add the flue mirror:

```javascript
// ── Self-host deploy: Flue → Cloudflare (npm install -> flue build -> wrangler deploy) ──
let __fluePoll = null;
async function renderFlueDeploy(el, selHtml){
  if (!wsCurrent){
    el.innerHTML = selHtml + `<div class="pgroup"><p class="note">Flue deploys a saved <b>workspace</b>'s flue project to Cloudflare Workers. Open or create a workspace first (the <b>Workspace</b> stage), then deploy it here.</p></div>`;
    attachDeployTargetListener(); return;
  }
  const ready = await (await fetch(`/api/run-ready?name=${encodeURIComponent(wsCurrent)}&target=flue`)).json();
  let h = `<div class="psummary">${selHtml}<div class="phead"><strong>${esc(wsCurrent)}</strong> <span class="d">· Flue → Cloudflare (self-host)</span></div>`;
  h += `<div class="pgroup"><button id="flueDeployBtn" ${ready.cloudflare ? "" : "disabled"}>${ready.cloudflare ? "▲ Deploy to Cloudflare" : "Deploy (set CLOUDFLARE_API_TOKEN)"}</button> <span class="d" id="flueDeployState"></span></div>`;
  h += `<div id="flueDeployUrl" style="margin:4px 0"></div>`;
  h += `<pre id="flueDeployLog" class="json" style="max-height:220px;overflow:auto" hidden></pre>`;
  h += `<p class="note">Runs <code>npm install</code> → <code>flue build --target cloudflare</code> → <code>wrangler deploy</code> on the workspace's flue project (re-rendered from the gem). Requires <code>CLOUDFLARE_API_TOKEN</code> on the server.</p></div>`;
  el.innerHTML = h;
  attachDeployTargetListener();
  const cur = await (await fetch(`/api/run-status?name=${encodeURIComponent(wsCurrent)}&target=flue`)).json();
  if (cur && cur.mode === "cloudflare" && (cur.state !== "idle" || cur.url)) { flueRenderRun(cur); if (eveRunning(cur.state)) fluePollRun(wsCurrent); }
  document.getElementById("flueDeployBtn")?.addEventListener("click", flueDeploy);
}
async function flueDeploy(){
  if (!wsCurrent) return;
  const btn = document.getElementById("flueDeployBtn"), st = document.getElementById("flueDeployState");
  if (btn) btn.disabled = true; if (st) st.textContent = "Deploying…";
  const s = await (await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: wsCurrent, target: "flue", mode: "cloudflare" }) })).json();
  flueRenderRun(s); fluePollRun(wsCurrent);
}
function flueRenderRun(s){
  const st = document.getElementById("flueDeployState"), url = document.getElementById("flueDeployUrl"), log = document.getElementById("flueDeployLog"), btn = document.getElementById("flueDeployBtn");
  if (!st) return;
  st.textContent = s.state || "";
  if (url) url.innerHTML = s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : "";
  if (log && s.logTail && s.logTail.length){ log.hidden = false; log.textContent = s.logTail.join("\n"); log.scrollTop = log.scrollHeight; }
  if (btn) btn.disabled = eveRunning(s.state);
}
function fluePollRun(ws){
  if (__fluePoll) clearInterval(__fluePoll);
  __fluePoll = setInterval(async () => {
    const s = await (await fetch(`/api/run-status?name=${encodeURIComponent(ws)}&target=flue`)).json();
    flueRenderRun(s);
    if (!eveRunning(s.state)) { clearInterval(__fluePoll); __fluePoll = null; }
  }, 1500);
}
```

- [ ] **Step 3: Build + verify (manual)**

Run: `npm run build`
Then run the app from a scratch testbed and confirm, in the Deploy tab Backend dropdown: `Eve → Vercel (self-host)` and `Flue → Cloudflare (self-host)` both appear; selecting Flue with a workspace open shows the "▲ Deploy to Cloudflare" button disabled as "Deploy (set CLOUDFLARE_API_TOKEN)" when the token is unset; with no workspace it shows the "open a workspace first" note. (Drive with the browser-harness like the eve verification.)

Run: `grep -n "flueDeploy\|flue-cloudflare" src/public/index.html` → expect the new option + functions present.

- [ ] **Step 4: Commit**

```bash
git add src/public/index.html
git commit -m "feat(deploy): surface Flue -> Cloudflare self-host backend in the Deploy tab"
```

---

## Self-Review

**Spec coverage:**
- Deployable flue project (src/ layout, flue.config.ts, package.json with type:module + agents/valibot deps, wrangler.jsonc with FlueRegistry + Flue<Pascal>Agent) → Task 1. ✓
- Validated deploy pipeline (npm install → flue build --target cloudflare → wrangler deploy, gated on CLOUDFLARE_API_TOKEN, workers.dev URL) → Task 2. ✓
- Endpoint wiring (cloudflare mode, target-scoped status/stop, run-ready.cloudflare) → Task 3. ✓
- Deploy-tab UI option mirroring eve → Task 4. ✓
- Breaking-change handling (flue materialize output moved under src/ + project files) → Task 1 updates the flue tests; no other repo code asserts the old flue paths (registry materialize writes whatever `materialize` returns; `schemas.test.ts` only references the flue *id*, not paths — verify with `grep -rn "agents/\|connections/" src --include=*.ts | grep -i flue`). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The run.test.ts happy-path deploy test references the existing eve test's fake-runner scaffolding rather than inlining it — Step 1 of Task 2 explicitly says to copy that scaffolding (the file's helper name must be read first); this is a concrete instruction, not a placeholder.

**Type consistency:** `RunMode`/`RunState.mode` include `"cloudflare"` in Task 2 and the schema enums in Task 3 match. `getRunStatus(name,target)` / `stopLocal(name,target)` two-arg signatures defined in Task 2 and called in Task 3. `runReadiness()` returns `{local,vercel,cloudflare}` in Task 2, schema in Task 3, UI reads `.cloudflare` in Task 4. `flueName`/`fluePascal` defined Task 1 used only within Task 1. DO class `Flue<Pascal>Agent` consistent between the emitted `wrangler.jsonc` and the test assertion (`FlueMyGemAgent` for "my gem").

**Risk note (flag during execution):** flue is `1.0.0-beta.*` — the DO class-naming convention (`Flue<Pascal(filename)>Agent`) and the `flue build`→`wrangler deploy` handoff were derived from a live CLI run, not a stability guarantee. If a future flue version changes either, Task 1's `wrangler.jsonc` migration class and Task 2's build command are the two places to update. A first real `wrangler deploy` against a Cloudflare account (with `CLOUDFLARE_API_TOKEN`) is the only way to confirm end-to-end beyond the validated `--dry-run`.

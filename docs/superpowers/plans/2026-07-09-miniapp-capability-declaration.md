# Miniapp Capability Declaration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split ownership of a miniapp's `needs` three ways — checkboxes express intent, the HTML declares, the Studio discloses — so a declared capability can never drift from the code that uses it.

**Architecture:** A capability↔tool bijection moves to `@agentgem/model` (re-exported through `@agentgem/play`, because `packages/console` depends on play but not model). `saveMiniapp` gains a reconciliation step that derives `needs` by scanning the HTML for literal `agentgem_*` tool names: a capability the code calls but doesn't declare **throws**; a capability declared but never called is **pruned and reported**. The Composer's new checkboxes only append text to the build prompt — they never write `meta.json`, so there is exactly one authority over `needs`.

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm workspaces, vitest, React 18, Zod, AgentBack REST controllers.

## Global Constraints

- Worktree: `../agentgem-miniapp-caps`, branch `feat/miniapp-capability-declaration`, based on `origin/main`. All commands run from the worktree root.
- Root tests run compiled output: `pnpm test` is `tsc -b && vitest run`. A rename leaves stale `dist/` — run `pnpm build` (or `tsc -b`) before `vitest`, never `vitest` alone after changing exports.
- Console tests are **not** in CI. Run them locally: `pnpm -C packages/console exec vitest run` and `pnpm -C packages/console typecheck`.
- `packages/console` depends on `@agentgem/play` only. It must **not** gain a direct `@agentgem/model` dependency — re-export through play's barrel instead.
- `skills/agentgem-miniapp/SKILL.md` must end byte-identically with `MINIAPP_BUILDER_BRIEF` from `packages/play/src/builderBrief.ts`. A drift guard test enforces this.
- The four capabilities, verbatim: `session-data`, `live-session-events`, `local-project-access`, `invoke-agent`.
- The four tool names, verbatim: `agentgem_get_session_data`, `agentgem_subscribe_sessions`, `agentgem_get_inventory`, `agentgem_invoke_agent`.
- Capability arrays are always **sorted ascending** so equality checks and test fixtures are stable. Sorted order is: `invoke-agent`, `live-session-events`, `local-project-access`, `session-data`.
- Never commit to `main`. Finish with a PR.

---

### Task 1: The capability↔tool bijection in `@agentgem/model`

The tool names are currently hand-written in six files, and the one map that matters (`CAP_TOOL`) lives in `packages/console` where `packages/play` cannot reach it. Move it next to the `GameCapability` union so both consumers share one definition.

**Files:**
- Create: `packages/model/src/capabilities.ts`
- Modify: `packages/model/src/index.ts` (add one barrel line)
- Modify: `packages/play/src/index.ts` (re-export, so console can import it)
- Test: `src/play/__tests__/capabilities.test.ts`

**Interfaces:**
- Consumes: `GameCapability` from `packages/model/src/types.ts`.
- Produces: `CAP_TOOL: Record<GameCapability, string>` and `TOOL_CAP: Record<string, GameCapability>`, both importable from `@agentgem/model` **and** from `@agentgem/play`.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/capabilities.test.ts`:

```ts
// src/play/__tests__/capabilities.test.ts
import { describe, it, expect } from "vitest";
import { CAP_TOOL, TOOL_CAP } from "@agentgem/play";

describe("capability <-> tool bijection", () => {
  it("maps every capability to its host tool", () => {
    expect(CAP_TOOL).toEqual({
      "session-data": "agentgem_get_session_data",
      "live-session-events": "agentgem_subscribe_sessions",
      "local-project-access": "agentgem_get_inventory",
      "invoke-agent": "agentgem_invoke_agent",
    });
  });

  it("TOOL_CAP is the exact inverse", () => {
    for (const [cap, tool] of Object.entries(CAP_TOOL)) expect(TOOL_CAP[tool]).toBe(cap);
    expect(Object.keys(TOOL_CAP)).toHaveLength(Object.keys(CAP_TOOL).length);
  });

  it("no tool name is a substring of another (the scan relies on this)", () => {
    const tools = Object.values(CAP_TOOL);
    for (const a of tools) for (const b of tools) if (a !== b) expect(b.includes(a)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm exec vitest run src/play/__tests__/capabilities.test.ts`
Expected: FAIL — `CAP_TOOL` is not exported from `@agentgem/play`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/model/src/capabilities.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The capability <-> MCP host-tool bijection. It lives beside the GameCapability union because two
// consumers must agree on it exactly: the console's host router (which dispatches a tool call to an
// executor) and packages/play's save-time reconciliation (which derives `needs` back out of the html).
// Two copies would drift silently. Keyed by GameCapability, so adding a capability to the union without
// naming its tool is a COMPILE error — the same guard portability.ts's CAP_CLASS uses.
import type { GameCapability } from "./types.js";

export const CAP_TOOL: Record<GameCapability, string> = {
  "session-data": "agentgem_get_session_data",
  "live-session-events": "agentgem_subscribe_sessions",
  "local-project-access": "agentgem_get_inventory",
  "invoke-agent": "agentgem_invoke_agent",
};

export const TOOL_CAP: Record<string, GameCapability> = Object.fromEntries(
  (Object.entries(CAP_TOOL) as [GameCapability, string][]).map(([cap, tool]) => [tool, cap]),
);
```

In `packages/model/src/index.ts`, add after the `export * from "./types.js";` line:

```ts
export * from "./capabilities.js";
```

In `packages/play/src/index.ts`, add a re-export line (console reaches the map through play):

```ts
// Re-exported so packages/console — which depends on @agentgem/play, not @agentgem/model — can share
// the one capability<->tool map instead of keeping a second copy.
export { CAP_TOOL, TOOL_CAP } from "@agentgem/model";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm exec vitest run src/play/__tests__/capabilities.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/capabilities.ts packages/model/src/index.ts packages/play/src/index.ts src/play/__tests__/capabilities.test.ts
git commit -m "feat(model): one capability<->host-tool map, shared by play and console"
```

---

### Task 2: Derive `needs` from the HTML

**Files:**
- Modify: `packages/play/src/gameGate.ts` (export `scannableCode`)
- Create: `packages/play/src/capabilityScan.ts`
- Modify: `packages/play/src/index.ts` (export the new symbols)
- Test: `src/play/__tests__/capabilityScan.test.ts`

**Interfaces:**
- Consumes: `CAP_TOOL`, `TOOL_CAP` (Task 1); `scannableCode(html: string): string` from `gameGate.ts`.
- Produces:
  - `deriveNeeds(html: string): GameCapability[]` — sorted, deduped.
  - `reconcileNeeds(html: string, declared: GameCapability[] | undefined): Reconciled`
  - `interface Reconciled { needs: GameCapability[]; pruned: GameCapability[]; missing: GameCapability[] }`

`scannableCode` already strips the bodies of inert `<script type="application/json">` elements using a tokenizer-correct walk. That is exactly what this scan needs: a baked session transcript naturally contains tool names as data, and a naive regex would count them.

The scan matches a tool name **anywhere in executable code**, not only inside `callTool(...)`. `packages/play/src/scaffolds.ts` receives session data purely by comparing `p.toolName === "agentgem_get_session_data"` inside `onNotification`, and never calls. A `callTool`-only scan would prune a capability the app genuinely receives.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/capabilityScan.test.ts`:

```ts
// src/play/__tests__/capabilityScan.test.ts
import { describe, it, expect } from "vitest";
import { deriveNeeds, reconcileNeeds } from "@agentgem/play";

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const code = (js: string) => `<script>${js}</script>`;

describe("deriveNeeds", () => {
  it("finds a capability used via callTool", () => {
    expect(deriveNeeds(page(code(`window.agentgemApp.callTool("agentgem_get_inventory", {})`))))
      .toEqual(["local-project-access"]);
  });

  it("finds a capability received only via onNotification toolName (scaffolds.ts does this)", () => {
    const js = `onNotification("ui/notifications/tool-result", (p) => { if (p.toolName === "agentgem_get_session_data") boot(); })`;
    expect(deriveNeeds(page(code(js)))).toEqual(["session-data"]);
  });

  it("ignores tool names inside an inert application/json data blob", () => {
    const blob = `<script id="game-data" type="application/json">${JSON.stringify({
      timeline: [{ role: "user", text: "call agentgem_invoke_agent for me" }],
    })}</script>`;
    expect(deriveNeeds(page(blob))).toEqual([]);
  });

  it("dedupes and sorts", () => {
    const js = `callTool("agentgem_invoke_agent"); callTool("agentgem_invoke_agent"); callTool("agentgem_get_session_data")`;
    expect(deriveNeeds(page(code(js)))).toEqual(["invoke-agent", "session-data"]);
  });

  it("returns [] for a pure offline snapshot", () => {
    expect(deriveNeeds(page(code(`const x = 1;`)))).toEqual([]);
  });
});

describe("reconcileNeeds", () => {
  it("reports a called-but-undeclared capability as missing", () => {
    const r = reconcileNeeds(page(code(`callTool("agentgem_subscribe_sessions")`)), []);
    expect(r.missing).toEqual(["live-session-events"]);
    expect(r.pruned).toEqual([]);
  });

  it("reports a declared-but-unused capability as pruned, and drops it from needs", () => {
    const r = reconcileNeeds(page(code(`const x = 1;`)), ["live-session-events"]);
    expect(r.pruned).toEqual(["live-session-events"]);
    expect(r.missing).toEqual([]);
    expect(r.needs).toEqual([]);
  });

  it("treats undefined declared as []", () => {
    const r = reconcileNeeds(page(code(`const x = 1;`)), undefined);
    expect(r).toEqual({ needs: [], pruned: [], missing: [] });
  });

  it("agrees when declaration matches code", () => {
    const r = reconcileNeeds(page(code(`callTool("agentgem_get_inventory")`)), ["local-project-access"]);
    expect(r).toEqual({ needs: ["local-project-access"], pruned: [], missing: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm exec vitest run src/play/__tests__/capabilityScan.test.ts`
Expected: FAIL — `deriveNeeds` is not exported from `@agentgem/play`.

- [ ] **Step 3: Write minimal implementation**

In `packages/play/src/gameGate.ts`, change the `scannableCode` declaration from private to exported. The function body is unchanged; only the keyword changes:

```ts
export function scannableCode(html: string): string {
```

Create `packages/play/src/capabilityScan.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Derive a miniapp's `needs` from its html, and reconcile that against what meta.json declares.
//
// Why a static scan is TOTAL here: gameGate bans fetch/XMLHttpRequest/WebSocket/EventSource/
// importScripts/sendBeacon outright, so `window.agentgemApp` is the ONLY channel a sealed miniapp has
// to the outside world. There is no second place a capability can hide. (This would not hold for an
// ordinary web app.)
//
// We match a tool name ANYWHERE in executable code, not just inside callTool(...): scaffolds.ts
// receives session data purely by comparing `p.toolName === "agentgem_get_session_data"` inside
// onNotification and never calls. A callTool-only scan would prune a capability the app truly receives.
//
// A dynamic tool name — callTool(t) where t is a variable — scans as nothing and gets pruned. That hole
// is closed by convention, not by this module: MINIAPP_BUILDER_BRIEF requires literal tool-name strings.
import type { GameCapability } from "@agentgem/model";
import { TOOL_CAP } from "@agentgem/model";
import { scannableCode } from "./gameGate.js";

export interface Reconciled {
  needs: GameCapability[];    // the reconciled truth: exactly what the code uses
  pruned: GameCapability[];   // declared, never used — narrowing, always safe, but reported
  missing: GameCapability[];  // used, never declared — widening, must be an authored act
}

export function deriveNeeds(html: string): GameCapability[] {
  const code = scannableCode(html);
  return Object.keys(TOOL_CAP)
    .filter((tool) => code.includes(tool))
    .map((tool) => TOOL_CAP[tool])
    .sort();
}

export function reconcileNeeds(html: string, declared: GameCapability[] | undefined): Reconciled {
  const needs = deriveNeeds(html);
  const d = declared ?? [];
  return {
    needs,
    missing: needs.filter((c) => !d.includes(c)),
    pruned: [...new Set(d.filter((c) => !needs.includes(c)))].sort(),
  };
}
```

In `packages/play/src/index.ts`, add:

```ts
export { deriveNeeds, reconcileNeeds, type Reconciled } from "./capabilityScan.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm exec vitest run src/play/__tests__/capabilityScan.test.ts`
Expected: PASS, 9 tests.

Then confirm nothing else broke in the gate: `pnpm exec vitest run src/play/__tests__/gameGate.static.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/gameGate.ts packages/play/src/capabilityScan.ts packages/play/src/index.ts src/play/__tests__/capabilityScan.test.ts
git commit -m "feat(play): derive miniapp needs from html, reconcile against the declaration"
```

---

### Task 3: Reconcile in `saveMiniapp` — throw on `missing`, prune on `extra`

**Files:**
- Modify: `packages/play/src/miniapps.ts:52-67` (`saveMiniapp`) and the exported result type
- Modify: `packages/play/src/index.ts` (export `SaveMiniappResult`)
- Test: `src/play/__tests__/miniapps.test.ts` (append)

**Interfaces:**
- Consumes: `reconcileNeeds` (Task 2); `CAP_TOOL` (Task 1).
- Produces: `interface SaveMiniappResult { name: string; commit: string | null; prunedNeeds: GameCapability[] }`. `saveMiniapp` now returns this instead of `{ name, commit }`. Tasks 4, 5 depend on the new field.

Order inside `saveMiniapp` matters: `gameGate` → **reconcile** → `assertPortable`. Reconcile must run *before* `assertPortable`, because pruning a phantom `session-data` is what lets an unbaked stub become portable rather than fail the save.

Three leaks to close, all in this one function:
1. `meta.json` gets the **pruned** meta.
2. `writeGameGem` gets the **pruned** meta — otherwise the shareable gem keeps the phantom capability and the whole exercise leaks.
3. The commit message names what was pruned.

- [ ] **Step 1: Write the failing test**

Append to `src/play/__tests__/miniapps.test.ts` (the file's existing `home`/`meta`/`sealed` fixtures are in scope):

```ts
describe("saveMiniapp reconciles needs against the html", () => {
  const uses = (tool: string) => `<!doctype html><body><canvas></canvas><script>window.agentgemApp.callTool("${tool}");</script></body>`;

  it("throws when the code calls a tool the meta does not declare", async () => {
    await expect(saveMiniapp({ name: "undeclared", html: uses("agentgem_subscribe_sessions"), meta }))
      .rejects.toThrow(/agentgem_subscribe_sessions.*live-session-events/s);
  });

  it("prunes a declared capability nothing uses, and reports it", async () => {
    const res = await saveMiniapp({ name: "over", html: sealed, meta: { ...meta, needs: ["live-session-events"] } });
    expect(res.prunedNeeds).toEqual(["live-session-events"]);
    const onDisk = JSON.parse(readFileSync(join(miniappDir("over"), "meta.json"), "utf8")) as { needs?: string[] };
    expect(onDisk.needs).toBeUndefined();
  });

  it("names the pruned capability in the commit message", async () => {
    await saveMiniapp({ name: "msg", html: sealed, meta: { ...meta, needs: ["invoke-agent"] } });
    const log = execFileSync("git", ["-C", join(home, "miniapps"), "log", "-1", "--pretty=%s"], { encoding: "utf8" });
    expect(log).toContain("pruned unused capability: invoke-agent");
  });

  it("writes the PRUNED needs into the game gem, not the authored ones", async () => {
    await saveMiniapp({ name: "gemprune", html: sealed, meta: { ...meta, needs: ["local-project-access"] } });
    const gem = readGemArchive(readArchiveDir(workspaceDir("gemprune")));
    expect((gem.artifacts[0] as { needs?: string[] }).needs).toBeUndefined();
  });

  it("keeps a capability the code actually uses", async () => {
    const res = await saveMiniapp({
      name: "kept", html: uses("agentgem_get_inventory"), meta: { ...meta, needs: ["local-project-access"] },
    });
    expect(res.prunedNeeds).toEqual([]);
    const gem = readGemArchive(readArchiveDir(workspaceDir("kept")));
    expect((gem.artifacts[0] as { needs?: string[] }).needs).toEqual(["local-project-access"]);
  });

  it("prunes a phantom session-data so an unbaked stub becomes portable (reconcile precedes assertPortable)", async () => {
    const res = await saveMiniapp({ name: "phantom", html: sealed, meta: { ...meta, needs: ["session-data"] } });
    expect(res.prunedNeeds).toEqual(["session-data"]);
  });
});
```

Add to that file's imports:

```ts
import { execFileSync } from "node:child_process";
```

(`readFileSync`, `join`, `workspaceDir`, `readGemArchive`, `readArchiveDir`, `miniappDir` are already imported at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm exec vitest run src/play/__tests__/miniapps.test.ts`
Expected: FAIL — `res.prunedNeeds` is `undefined`; the "throws" test fails because the save succeeds.

- [ ] **Step 3: Write minimal implementation**

In `packages/play/src/miniapps.ts`, add to the imports:

```ts
import { CAP_TOOL } from "@agentgem/model";
import { reconcileNeeds } from "./capabilityScan.js";
```

Add the result type next to `SaveMiniappInput`:

```ts
export interface SaveMiniappResult { name: string; commit: string | null; prunedNeeds: GameCapability[] }
```

Widen the `@agentgem/model` type import on line 10 to include `GameCapability` (it already imports `GameArtifact`, `GameGenre`, `GameSource`).

Replace the body of `saveMiniapp` with:

```ts
export async function saveMiniapp(input: SaveMiniappInput): Promise<SaveMiniappResult> {
  const dir = miniappDir(input.name);             // validates the name (throws on bad) + jails the path
  const safe = input.name;
  const gate = await gameGate(input.html);
  if (!gate.ok) throw new Error(`miniapp failed the gate: ${gate.failures.join("; ")}`);

  // Reconcile the DECLARATION against the CODE. The two drift directions are not symmetric: calling an
  // undeclared tool WIDENS what the app reaches, so it must be a deliberate authored act (throw, and let
  // the agent self-repair from the failure string, exactly as it does for a gate failure). Declaring a
  // tool nothing calls NARROWS to nothing — always safe — so prune it, but never silently. This runs
  // BEFORE assertPortable so a pruned phantom `session-data` no longer demands a baked fallback.
  const rec = reconcileNeeds(input.html, input.meta.needs);
  if (rec.missing.length) {
    const detail = rec.missing.map((c) => `${CAP_TOOL[c]} (declare "${c}")`).join("; ");
    throw new Error(`miniapp calls a host tool it does not declare: ${detail} — add it to meta.json "needs"`);
  }
  const meta: MiniappMeta = { ...input.meta };
  if (rec.needs.length) meta.needs = rec.needs; else delete meta.needs;

  const port = assertPortable(input.html, meta.needs);
  if (!port.ok) throw new Error(`miniapp is not portable: ${port.failures.join("; ")}`);
  const root = miniappsRoot();
  await ensureRepo(root);                          // the registry is a git repo
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${safe}.html`), input.html);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  const note = rec.pruned.length ? ` (pruned unused capability: ${rec.pruned.join(", ")})` : "";
  const commit = await commitWithLock(root, `save miniapp ${safe}${note}`);
  writeGameGem(safe, input.html, meta);            // the PRUNED meta — a phantom cap must not reach the gem
  return { name: safe, commit, prunedNeeds: rec.pruned };
}
```

In `packages/play/src/index.ts`, add `SaveMiniappResult` to the existing `./miniapps.js` export list:

```ts
export { miniappsRoot, miniappDir, saveMiniapp, checkpointMiniapp, readMiniapp, listMiniapps, migrateAllMiniapps, type MiniappMeta, type SaveMiniappInput, type SaveMiniappResult } from "./miniapps.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm exec vitest run src/play/__tests__/miniapps.test.ts src/play/__tests__/portability.test.ts`
Expected: PASS. Note `portability.test.ts` calls `assertPortable` directly and is unaffected; if one of its `saveMiniapp` cases now fails, the fixture declared a capability its HTML never used — fix the fixture's HTML to call the tool, not the assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/miniapps.ts packages/play/src/index.ts src/play/__tests__/miniapps.test.ts
git commit -m "feat(play): saveMiniapp throws on undeclared tool calls, prunes unused declarations"
```

---

### Task 4: Guard the migration and checkpoint paths

`migrateAllMiniapps` calls `saveMiniapp`, so it inherits the reconciliation. A symmetric equality check would have made migration **throw** on exactly the two over-declared miniapps that exist on disk today. Prune makes it clean them instead. `checkpointMiniapp` must reconcile nothing — it is the durability path and must never fail.

**Files:**
- Test: `src/play/__tests__/migrateMiniapps.test.ts` (append)
- Test: `src/play/__tests__/checkpoint.test.ts` (append)
- No source changes expected. If a test fails, the bug is in Task 3.

**Interfaces:**
- Consumes: `saveMiniapp` / `SaveMiniappResult` (Task 3), `checkpointMiniapp`, `migrateAllMiniapps`.
- Produces: nothing. Regression guards only.

- [ ] **Step 1: Write the failing test**

Append to `src/play/__tests__/migrateMiniapps.test.ts`:

```ts
it("cleans an over-declared miniapp instead of throwing (the two on disk today)", async () => {
  // Seed a miniapp the way seedStudio does: meta.json declares a genre's needs before any code exists.
  const dir = miniappDir("live-watch");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "live-watch.html"), "<!doctype html><body><canvas></canvas><script>const x=1;</script></body>");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({
    title: "Live Watch", genre: "project-fun", createdFrom: { kind: "blank", title: "Live Watch" },
    engineVersion: "1", needs: ["live-session-events"],
  }));

  await expect(migrateAllMiniapps()).resolves.toBeDefined();  // must not throw

  const after = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { needs?: string[] };
  expect(after.needs).toBeUndefined();
});
```

Ensure that file imports `mkdirSync`, `writeFileSync`, `readFileSync` from `node:fs`, `join` from `node:path`, and `miniappDir`, `migrateAllMiniapps` from `@agentgem/play`.

Append to `src/play/__tests__/checkpoint.test.ts`:

```ts
it("checkpoint never reconciles needs — it must not rewrite meta or fail", async () => {
  const dir = miniappDir("ckpt-caps");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ckpt-caps.html"), "<!doctype html><body><canvas></canvas><script>const x=1;</script></body>");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({
    title: "C", genre: "project-fun", createdFrom: { kind: "blank", title: "C" },
    engineVersion: "1", needs: ["invoke-agent"],
  }));

  await expect(checkpointMiniapp("ckpt-caps")).resolves.toBeDefined();

  const after = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { needs?: string[] };
  expect(after.needs).toEqual(["invoke-agent"]);   // untouched: durability, not sealing
});
```

Ensure that file imports the same helpers plus `checkpointMiniapp`.

- [ ] **Step 2: Run tests to verify they fail (or pass, revealing the truth)**

Run: `pnpm build && pnpm exec vitest run src/play/__tests__/migrateMiniapps.test.ts src/play/__tests__/checkpoint.test.ts`
Expected: both PASS if Task 3 is correct. If the migrate test throws, `saveMiniapp` is erroring on `extra` instead of pruning — fix Task 3, not the test. If the checkpoint test shows `needs: undefined`, `checkpointMiniapp` is wrongly routing through `saveMiniapp` — fix Task 3.

- [ ] **Step 3: No implementation needed**

These guard behavior established in Task 3. Skip to verification.

- [ ] **Step 4: Run the whole play suite**

Run: `pnpm build && pnpm exec vitest run src/play/`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add src/play/__tests__/migrateMiniapps.test.ts src/play/__tests__/checkpoint.test.ts
git commit -m "test(play): migration prunes over-declared needs; checkpoint leaves meta alone"
```

---

### Task 5: Carry `prunedNeeds` across the REST boundary

`PlaySaveResponseSchema` is duplicated — server at `src/schemas.ts:967`, client at `packages/console/src/api/routes.ts:919`. Zod strips unknown keys, so if only one side grows the field, the client silently receives nothing. Both change in this task, together.

**Files:**
- Modify: `src/schemas.ts:967`
- Modify: `src/play.controller.ts:19-24`
- Modify: `packages/console/src/api/routes.ts:919-922`
- Test: `src/play/__tests__/saveRoute.test.ts` (create)

**Interfaces:**
- Consumes: `SaveMiniappResult` (Task 3).
- Produces: `POST /api/play/save` responds `{ name: string; commit: string | null; prunedNeeds: GameCapability[] }`. Task 6 consumes `prunedNeeds`.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/saveRoute.test.ts`:

```ts
// src/play/__tests__/saveRoute.test.ts
import { describe, it, expect } from "vitest";
import { PlaySaveResponseSchema } from "../../schemas.js";

describe("PlaySaveResponseSchema", () => {
  it("carries prunedNeeds", () => {
    const parsed = PlaySaveResponseSchema.parse({ name: "g", commit: "abc1234", prunedNeeds: ["invoke-agent"] });
    expect(parsed.prunedNeeds).toEqual(["invoke-agent"]);
  });

  it("defaults prunedNeeds to [] so an older server does not crash the client", () => {
    expect(PlaySaveResponseSchema.parse({ name: "g", commit: null }).prunedNeeds).toEqual([]);
  });

  it("rejects a capability outside the union", () => {
    expect(() => PlaySaveResponseSchema.parse({ name: "g", commit: null, prunedNeeds: ["nope"] })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm exec vitest run src/play/__tests__/saveRoute.test.ts`
Expected: FAIL — `parsed.prunedNeeds` is `undefined` (Zod strips the unknown key).

- [ ] **Step 3: Write minimal implementation**

In `src/schemas.ts`, replace line 967:

```ts
export const PlaySaveResponseSchema = z.object({
  name: z.string(),
  commit: z.string().nullable(),
  // Declared capabilities the html never used. Reported, never silent — the Studio surfaces these.
  prunedNeeds: z.array(z.enum(["session-data", "live-session-events", "local-project-access", "invoke-agent"])).default([]),
});
```

In `src/play.controller.ts`, the `save` method already returns `saveMiniapp(...)` directly and now carries the field. No change is needed — but verify the return type still satisfies `z.infer<typeof PlaySaveResponseSchema>`; `tsc` will say so.

In `packages/console/src/api/routes.ts`, replace the `playSaveRoute` response:

```ts
export const playSaveRoute = defineRoute("POST", "/api/play/save", {
  body: z.object({ name: z.string(), html: z.string(), meta: PlayMetaSchema }),
  response: z.object({
    name: z.string(),
    commit: z.string().nullable(),
    prunedNeeds: z.array(z.enum(["session-data", "live-session-events", "local-project-access", "invoke-agent"])).default([]),
  }),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm build && pnpm exec vitest run src/play/__tests__/saveRoute.test.ts`
Expected: PASS, 3 tests.

Run: `pnpm -C packages/console typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/play.controller.ts packages/console/src/api/routes.ts src/play/__tests__/saveRoute.test.ts
git commit -m "feat(api): POST /api/play/save reports prunedNeeds"
```

---

### Task 6: The Studio capabilities strip

`Studio.tsx` already holds `meta` in state (line 41), posts it on save (line 164), and feeds `meta?.needs` into `<Runner needs=…>` (line 275). So the strip renders `meta.needs` and costs no new state: after a save returns `prunedNeeds`, `setMeta` drops them, the strip updates, and `Runner`'s effect re-runs on the new `needs` and renegotiates with the host.

**Files:**
- Create: `packages/console/src/panels/Play/CapabilityStrip.tsx`
- Modify: `packages/console/src/panels/Play/Studio.tsx` (state, `save()`, render)
- Modify: `packages/console/src/panels/Play/consent.ts` (export an ordered list)
- Test: `packages/console/src/panels/Play/__tests__/Studio.test.tsx` (append)

**Interfaces:**
- Consumes: `prunedNeeds` from `playSaveRoute` (Task 5); `CAP_LABEL` from `consent.ts`.
- Produces:
  - `consent.ts`: `export const CONSENT_CAPS = ["local-project-access", "live-session-events", "invoke-agent"] as const;` — consumed again by Task 7.
  - `CapabilityStrip({ needs, pruned }: { needs?: string[]; pruned: string[] })`.

`session-data` has no `CAP_LABEL` entry (it is in `AUTO_CAPS`). The strip must render it with a fallback label rather than blank.

- [ ] **Step 1: Write the failing test**

Append to `packages/console/src/panels/Play/__tests__/Studio.test.tsx`. The file has **no** shared render helper — each test builds its own. Add `playSaveRoute` to the existing `../../../api/routes.js` import, then add this helper and the two tests. `FakeES` and `IdentityProvider` are already defined/imported at the top of the file.

```tsx
// Studio mounts an agent list over raw fetch and an EventSource; stub both, then the two client routes.
const renderStudio = (needs: string[]) => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch);
  vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
  vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
    name: "g1",
    html: "<!doctype html><body><canvas></canvas></body>",
    meta: {
      title: "G1", genre: "project-fun", engineVersion: "1",
      createdFrom: { kind: "project", path: "/p", flavor: "node" }, needs,
    },
  } as never);
  return render(<IdentityProvider apiBase=""><Studio
    apiBase="" name="g1"
    agents={[{ id: "codex", name: "Codex", available: true }]}
    agentId="codex" onAgentIdChange={() => {}} onBack={() => {}}
  /></IdentityProvider>);
};

it("lists each declared capability with the cost the viewer will see", async () => {
  renderStudio(["live-session-events"]);
  expect(await screen.findByText(/watch your live coding sessions in real time/i)).toBeTruthy();
});

it("announces a prune after save and drops the capability from the strip", async () => {
  renderStudio(["invoke-agent"]);
  vi.spyOn(playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: ["invoke-agent"] });
  expect(await screen.findByText(/run a local AI agent on your machine/i)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(await screen.findByText(/removed invoke-agent — nothing in the miniapp uses it/i)).toBeTruthy();
  await waitFor(() => expect(screen.queryByText(/run a local AI agent on your machine/i)).toBeNull());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/Studio.test.tsx`
Expected: FAIL — no element matches the capability label.

- [ ] **Step 3: Write minimal implementation**

In `packages/console/src/panels/Play/consent.ts`, add below `CAP_LABEL`:

```ts
// The consent-gated capabilities, in display order. `session-data` is deliberately absent: AUTO_CAPS
// marks it auto-approved (declared at seed), so it is never something a user opts into.
export const CONSENT_CAPS = ["local-project-access", "live-session-events", "invoke-agent"] as const;
```

Create `packages/console/src/panels/Play/CapabilityStrip.tsx`:

```tsx
// packages/console/src/panels/Play/CapabilityStrip.tsx
// Disclosure, not control. It renders the RECONCILED `needs` — the capabilities the miniapp's code
// actually uses — each labelled with the cost the viewer will see in their consent prompt. There is no
// toggle here on purpose: the code is the single authority over `needs`, and a toggle would reintroduce
// the second authority the save-time reconciliation exists to remove.
import { CAP_LABEL } from "./consent.js";

const AUTO_LABEL = "read this miniapp's own source session";  // session-data: auto-approved, no CAP_LABEL

export function CapabilityStrip({ needs, pruned }: { needs?: string[]; pruned: string[] }) {
  if (!needs?.length && !pruned.length) return null;
  return (
    <div className="play-caps">
      {needs?.map((cap) => (
        <div key={cap} className="play-caps__row">
          <code className="play-caps__cap">{cap}</code>
          <span className="play-caps__cost">{CAP_LABEL[cap] ?? AUTO_LABEL}</span>
        </div>
      ))}
      {pruned.map((cap) => (
        <div key={`pruned-${cap}`} className="play-caps__row play-caps__row--pruned">
          removed {cap} — nothing in the miniapp uses it
        </div>
      ))}
    </div>
  );
}
```

In `packages/console/src/panels/Play/Studio.tsx`:

Add the import:

```tsx
import { CapabilityStrip } from "./CapabilityStrip.js";
```

Add state beside the existing `meta` state (line 41):

```tsx
const [pruned, setPruned] = useState<string[]>([]);
```

In `save()`, capture the response and apply the prune (replace the `await playSaveRoute.call(...)` statement and the `setStatus("saved ✓")` line):

```tsx
const res = await playSaveRoute.call(makeClient(apiBase), { body: { name, html: cur.html, meta: {
  title: cur.meta.title, genre: cur.meta.genre as "replay" | "skill-run" | "project-fun",
  createdFrom: cur.meta.createdFrom, engineVersion: cur.meta.engineVersion,
  ...(cur.meta.needs ? { needs: cur.meta.needs } : {}),
} } });
// The save is the reconciliation. Drop what it pruned so the strip tells the truth and <Runner needs>
// renegotiates with the host on the correct set.
setPruned(res.prunedNeeds);
if (res.prunedNeeds.length) {
  setMeta((m) => (m ? { ...m, needs: (m.needs ?? []).filter((n) => !res.prunedNeeds.includes(n)) } : m));
}
setStatus("saved ✓"); return true;
```

Render the strip under the title row (after the `<span className="play-studio-title">…</span>` header block closes):

```tsx
<CapabilityStrip needs={meta?.needs} pruned={pruned} />
```

Add styles to `packages/console/src/shell/theme.css`:

```css
.play-caps { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 10px; }
.play-caps__row { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
.play-caps__cap { font-family: var(--font-mono); opacity: 0.75; }
.play-caps__cost { opacity: 0.65; }
.play-caps__row--pruned { font-size: 12px; opacity: 0.7; font-style: italic; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/Studio.test.tsx`
Expected: PASS.

Run: `pnpm -C packages/console typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/CapabilityStrip.tsx packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/consent.ts packages/console/src/shell/theme.css packages/console/src/panels/Play/__tests__/Studio.test.tsx
git commit -m "feat(console): Studio capability strip discloses needs and announces prunes"
```

---

### Task 7: Composer checkboxes — intent, above the tabs

They append text to the build prompt and **nothing else**. No code path may write `needs` from a checkbox; that is what keeps `needs` single-authority. `onCreated(name, seedPrompt?)` already accepts a prompt — today only `doBlank()` passes one. Now `seed()` does too, so a Project- or Session-sourced miniapp can request a live connection.

**Files:**
- Modify: `packages/console/src/panels/Play/Composer.tsx`
- Test: `packages/console/src/panels/Play/__tests__/Composer.test.tsx` (append)

**Interfaces:**
- Consumes: `CONSENT_CAPS`, `CAP_LABEL` from `consent.ts` (Task 6).
- Produces: nothing downstream. `onCreated`'s existing `seedPrompt` argument now carries a capability preamble.

- [ ] **Step 1: Write the failing test**

In `packages/console/src/panels/Play/__tests__/Composer.test.tsx`, first widen the existing helper's callback type on line 10 so the tests can read the second argument:

```tsx
const renderComposer = (onCreated: (name: string, seedPrompt?: string) => void) =>
  render(<Composer apiBase="" agents={agents} agentId="codex" onAgentIdChange={() => {}} onCreated={onCreated} />);
```

Then append these tests. `CAP_LABEL` supplies the checkbox text, so `getByLabelText` matches on the cost string:

```tsx
describe("Composer capability checkboxes", () => {
  const stubProjects = () =>
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({
      projects: [{ path: "/p/demo", flavor: "node", lastUsed: null, exists: true }],
    } as never);

  it("passes a capability preamble as the seed prompt when a box is checked", async () => {
    stubProjects();
    vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "demo" });
    const onCreated = vi.fn();
    renderComposer(onCreated);
    await waitFor(() => expect(screen.getByText("/p/demo")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/watch your live coding sessions in real time/i));
    fireEvent.click(screen.getByText("/p/demo"));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const seedPrompt = onCreated.mock.calls[0][1] as string;
    expect(seedPrompt).toContain("agentgem_subscribe_sessions");
    expect(seedPrompt).toContain("live-session-events");
  });

  it("passes no seed prompt when nothing is checked", async () => {
    stubProjects();
    vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "demo" });
    const onCreated = vi.fn();
    renderComposer(onCreated);
    await waitFor(() => expect(screen.getByText("/p/demo")).toBeTruthy());
    fireEvent.click(screen.getByText("/p/demo"));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onCreated.mock.calls[0][1]).toBeUndefined();
  });

  it("never sends needs to the server — checkboxes are intent, not declaration", async () => {
    stubProjects();
    const studio = vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "demo" });
    renderComposer(vi.fn());
    await waitFor(() => expect(screen.getByText("/p/demo")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/run a local AI agent on your machine/i));
    fireEvent.click(screen.getByText("/p/demo"));
    await waitFor(() => expect(studio).toHaveBeenCalled());
    expect(JSON.stringify(studio.mock.calls[0][1])).not.toContain("needs");
  });

  it("combines the preamble with the Blank tab description", async () => {
    stubProjects();
    vi.spyOn(playBlankRoute, "call").mockResolvedValue({ name: "my-app" });
    const onCreated = vi.fn();
    renderComposer(onCreated);
    fireEvent.click(screen.getByText("Blank"));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "My App" } });
    fireEvent.change(screen.getByPlaceholderText(/describe the mini-game/i), { target: { value: "a dashboard" } });
    fireEvent.click(screen.getByLabelText(/read your local setup/i));
    fireEvent.click(screen.getByRole("button", { name: /Create miniapp/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const seedPrompt = onCreated.mock.calls[0][1] as string;
    expect(seedPrompt).toContain("agentgem_get_inventory");
    expect(seedPrompt).toContain("a dashboard");
  });
});
```

Note the tab buttons are plain `<button>` elements rendered from `TABS`, so `getByText("Blank")` selects the tab; the submit control is matched by its `Create miniapp` label.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/Composer.test.tsx`
Expected: FAIL — `getByLabelText` finds no checkbox.

- [ ] **Step 3: Write minimal implementation**

In `packages/console/src/panels/Play/Composer.tsx`, add the import:

```tsx
import { CAP_LABEL, CONSENT_CAPS } from "./consent.js";
```

Add the tool map and preamble builder above the component:

```tsx
// The capability -> tool names the preamble instructs the agent to call. Intentionally a local literal
// rather than an import from @agentgem/play: this string is PROMPT TEXT, not a contract the host
// enforces. The contract is enforced at save, by reconciling the html against meta.json.
const CAP_TOOL_HINT: Record<string, string> = {
  "local-project-access": "agentgem_get_inventory",
  "live-session-events": "agentgem_subscribe_sessions",
  "invoke-agent": "agentgem_invoke_agent",
};

// Checkboxes are INTENT: they only steer the agent's first prompt. They never write meta.json — the
// code is the single authority over `needs`, reconciled at save. An unchecked box that the agent uses
// anyway fails the save; a checked box the agent ignores is pruned back out and reported.
function capPreamble(caps: string[]): string {
  if (!caps.length) return "";
  const lines = caps.map((c) => `- ${c} — call \`${CAP_TOOL_HINT[c]}\` via window.agentgemApp`);
  return [
    "This miniapp should use these host capabilities. For each one, call the listed MCP tool and add the",
    'capability to `"needs"` in meta.json:',
    ...lines,
  ].join("\n");
}
```

Add state inside the component, beside the other `useState` calls:

```tsx
const [caps, setCaps] = useState<string[]>([]);
const toggleCap = (c: string) => setCaps((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
```

Change `seed()` to pass the preamble:

```tsx
async function seed(source: Source) {
  if (busy) return;
  setBusy(true); setError("");
  try {
    const res = await playStudioRoute.call(makeClient(apiBase), { body: { source } });
    onCreated(res.name, capPreamble(caps) || undefined);
  } catch (e) { setError((e as Error).message); setBusy(false); }
}
```

Change the last line of `doBlank()` from `onCreated(res.name, blankPrompt.trim() || undefined);` to:

```tsx
onCreated(res.name, [capPreamble(caps), blankPrompt.trim()].filter(Boolean).join("\n\n") || undefined);
```

Render the checkboxes between `<AgentSelector …/>` and `<div className="play-tabs">`:

```tsx
<fieldset className="play-caps-pick">
  <legend>This miniapp may:</legend>
  {CONSENT_CAPS.map((c) => (
    <label key={c} className="play-caps-pick__row">
      <input type="checkbox" checked={caps.includes(c)} onChange={() => toggleCap(c)} />
      <span>{CAP_LABEL[c]}</span>
    </label>
  ))}
</fieldset>
```

Add styles to `packages/console/src/shell/theme.css`:

```css
.play-caps-pick { border: 0; padding: 0; margin: 10px 0; }
.play-caps-pick legend { font-size: 12px; opacity: 0.7; padding: 0; }
.play-caps-pick__row { display: flex; gap: 8px; align-items: center; font-size: 13px; margin-top: 4px; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/Composer.test.tsx`
Expected: PASS, 4 new tests.

Run: `pnpm -C packages/console exec vitest run && pnpm -C packages/console typecheck`
Expected: full console suite green, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/Composer.tsx packages/console/src/shell/theme.css packages/console/src/panels/Play/__tests__/Composer.test.tsx
git commit -m "feat(console): Composer capability checkboxes steer the build prompt"
```

---

### Task 8: Teach the authoring contract the literal-tool-name rule

The scan cannot see `callTool(t)` where `t` is a variable — that capability gets pruned and the miniapp fails at runtime with `-32601`. This design closes that hole by convention, in the contract handed to the Studio agent. `builderBrief.ts` is the single source of truth; `SKILL.md` is a byte-identical view of it below its frontmatter, and `src/play/__tests__/builderBrief.test.ts` fails if they drift.

**Files:**
- Modify: `packages/play/src/builderBrief.ts`
- Modify: `skills/agentgem-miniapp/SKILL.md`
- Test: `src/play/__tests__/builderBrief.test.ts` (append)

**Interfaces:**
- Consumes: `MINIAPP_BUILDER_BRIEF`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `src/play/__tests__/builderBrief.test.ts`:

```ts
it("requires literal tool-name strings (the scan cannot see a dynamic name)", () => {
  expect(MINIAPP_BUILDER_BRIEF).toContain("literal string");
});

it("explains that Save reconciles needs against the code", () => {
  expect(MINIAPP_BUILDER_BRIEF).toContain("Save reconciles");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm exec vitest run src/play/__tests__/builderBrief.test.ts`
Expected: FAIL on both new assertions.

- [ ] **Step 3: Write minimal implementation**

In `packages/play/src/builderBrief.ts`, replace the line

```
Editing \`meta.json\` takes effect on the next Save; reload the preview to renegotiate.
```

with:

```
Editing \`meta.json\` takes effect on the next Save; reload the preview to renegotiate.

**Save reconciles \`needs\` against your code.** Call a tool you did not declare and the Save fails,
naming the capability to add. Declare a capability nothing calls and it is pruned back out, and you are
told. So \`needs\` can never drift from what the miniapp actually does.

Pass every tool name as a **literal string** — \`callTool("agentgem_get_inventory")\`, never
\`callTool(name)\`. The reconciler reads your source; a name it cannot see is a capability it prunes,
and your call then fails at runtime with \`-32601\`.
```

Then apply the *same* text to `skills/agentgem-miniapp/SKILL.md`, unescaping the backticks (the markdown file has no `\`` escapes — it is the rendered view of the template literal). The drift guard asserts `SKILL.md.endsWith(MINIAPP_BUILDER_BRIEF)`, so the bodies must match byte for byte.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm build && pnpm exec vitest run src/play/__tests__/builderBrief.test.ts`
Expected: PASS — including the pre-existing `mirrors MINIAPP_BUILDER_BRIEF verbatim (drift guard)` test. If the drift guard fails, the two bodies differ; diff them rather than adjusting the test.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/builderBrief.ts skills/agentgem-miniapp/SKILL.md src/play/__tests__/builderBrief.test.ts
git commit -m "docs(play): the builder contract requires literal tool names, explains reconciliation"
```

---

### Task 9: Full verification and PR

**Files:** none — verification only.

- [ ] **Step 1: Run the full root suite**

Run: `pnpm test`
Expected: PASS. Per the repo's known flake, if `observeScan`/`scorecard` real-FS tests time out under full-suite concurrency, re-run those files in isolation to confirm they pass before treating it as a regression.

- [ ] **Step 2: Run the console suite (not in CI — must be run locally)**

Run: `pnpm -C packages/console exec vitest run && pnpm -C packages/console typecheck`
Expected: PASS, no type errors.

- [ ] **Step 3: Reconcile the real miniapps on disk**

Run: `pnpm exec agentgem play migrate` (or invoke `migrateAllMiniapps()` via the `/api/play/migrate` route).
Expected: `live-watch` and `session-2de8e278-…` have `needs` removed from their `meta.json`; no throw. Verify with:

```bash
cat ~/.agentgem/miniapps/live-watch/meta.json
git -C ~/.agentgem/miniapps log --oneline -3
```

Expected: no `needs` key, and a commit naming the pruned capability.

- [ ] **Step 4: Confirm the branch is ahead of origin/main only**

```bash
git fetch origin && git log --oneline origin/main..HEAD && git log --oneline HEAD..origin/main
```

Expected: the second command prints nothing (not built on a stale local `main`).

- [ ] **Step 5: Push and open a PR**

```bash
git push -u origin feat/miniapp-capability-declaration
gh pr create --fill
```

Then `gh run watch <run-id> --exit-status`, and only once `test (24)` + `test (26)` are green, `gh pr merge --rebase --delete-branch`. The local branch-delete step will error because `main` is checked out in another worktree — the remote merge still succeeds. Afterwards, `git fetch` and grep `origin/main:packages/play/src/capabilityScan.ts` and `origin/main:packages/console/src/panels/Play/CapabilityStrip.tsx` to confirm **every** commit landed, not just the first.

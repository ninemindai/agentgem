# Play Foundation — Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a "game" a first-class gem artifact with its own cut, and ship the server-side validation gate that decides whether a generated game bundle is safe and runnable — the foundation every later Play plan builds on.

**Architecture:** Extend `@agentgem/model`'s artifact union with a `GameArtifact` (pre-bundled, self-contained HTML) and add a `game` cut to the classifier. Create a new `packages/play` package holding `gameGate.ts` — a two-check validator (static "self-contained" check + a jsdom load-smoke) with no headless browser. All logic is unit-tested from the repo-root `src/**/__tests__` tree (the only tests CI runs).

**Tech Stack:** TypeScript (nodenext, strict), pnpm workspaces, `tsc -b` project references, vitest (runs compiled `dist/**/__tests__/**/*.test.js`), jsdom (new dep, in `packages/play` only).

## Global Constraints

- **Node floor: >= 24.** CI runs `test (24)` and `test (26)`.
- **Tests live at repo-root `src/<area>/__tests__/*.test.ts`**, import package code via `@agentgem/<pkg>`, and are run by the root vitest (`dist/**/__tests__/**/*.test.js`). Package-local `packages/*/src/__tests__` are NOT in CI — do not put CI-critical tests there.
- **Test command:** `pnpm test` (= `tsc -b && vitest run`). Target one file with `pnpm test -- <substring>` after a build, or `npx vitest run dist/<area>/__tests__/<file>.test.js`.
- **`tsc -b` is the source of truth for union breakage.** Adding to `ArtifactType` may surface compile errors at consumers; the build must be green before any task is "done".
- **Leaf package tsconfig:** mirror `packages/model/tsconfig.json` (`composite: true`, `declaration: true`, `rootDir: src`, `outDir: dist`). Register new packages in the root `tsconfig.json` `references` array and (if root code imports them) in root `package.json` dependencies as `"workspace:*"`.
- **Gemstone for the game cut is `Ruby`.** `Amethyst` is already taken by `kit`.
- **Commits:** author `Raymond Feng <raymond@ninemind.ai>`; end every commit message body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Clean `dist` after any rename/move** (`pnpm clean`) — vitest runs compiled output; stale `dist` causes phantom passes/failures.

---

### Task 1: Extend the artifact model with `GameArtifact`

**Files:**
- Modify: `packages/model/src/types.ts:4` (ArtifactType union) and `:97` (GemArtifact union); add new interfaces after `SubagentArtifact` (`:41`).
- Test: `src/gem/__tests__/gameArtifact.test.ts` (new)

**Interfaces:**
- Produces: `type GameGenre = "replay" | "skill-run" | "project-fun"`; `type GameCapability = "live-session-events"`; `type GameSource` (discriminated by `kind`); `interface GameArtifact { type:"game"; name; title; genre; html; poster?; createdFrom; engineVersion; needs?; meta? }`. Later tasks/plans consume `GameArtifact` and `GameGenre`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/gameArtifact.test.ts`:

```ts
// src/gem/__tests__/gameArtifact.test.ts
import { describe, it, expect } from "vitest";
import type { GameArtifact, GemArtifact } from "@agentgem/model";

describe("GameArtifact", () => {
  it("is assignable to GemArtifact and narrows on type:'game'", () => {
    const g: GameArtifact = {
      type: "game",
      name: "auth-bugfix-replay",
      title: "The Great Auth Bug Hunt",
      genre: "replay",
      html: "<!doctype html><body><canvas></canvas></body>",
      createdFrom: { kind: "session", agent: "claude", sessionId: "s1", summary: "fixed auth bug" },
      engineVersion: "1",
    };
    const a: GemArtifact = g; // must compile
    expect(a.type).toBe("game");
    if (a.type === "game") expect(a.genre).toBe("replay"); // narrows
  });

  it("accepts a declared read-only capability and each source kind", () => {
    const withNeeds: GameArtifact = {
      type: "game", name: "n", title: "T", genre: "skill-run",
      html: "<!doctype html>", engineVersion: "1",
      needs: ["live-session-events"],
      createdFrom: { kind: "skill", skillName: "brainstorming" },
      meta: { controls: "arrow keys", estPlaySeconds: 120 },
    };
    const project: GameArtifact["createdFrom"] = { kind: "project", path: "/x", flavor: "node" };
    expect(withNeeds.needs).toEqual(["live-session-events"]);
    expect(project.kind).toBe("project");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- gameArtifact`
Expected: FAIL — `tsc -b` errors ("`GameArtifact` is not exported", `"game"` not assignable).

- [ ] **Step 3: Add the types**

In `packages/model/src/types.ts`, change line 4 to include `game`:

```ts
export type ArtifactType = "skill" | "mcp_server" | "instructions" | "hook" | "channel" | "subagent" | "game";
```

Insert after `SubagentArtifact` (after line 41):

```ts
// A pre-bundled, self-contained mini-game authored by the Play feature. `html` carries its own
// inline JS/CSS and data: assets — it is run in a sealed sandboxed iframe (no network, no LLM at
// runtime). `createdFrom` is provenance only (a reference + one-line summary), never the raw source.
export type GameGenre = "replay" | "skill-run" | "project-fun"; // v2: "watch" | "team"

// A read-only live-data capability a game may DECLARE. The trusted Play host, not the game, decides
// whether to forward it (consent-gated). Absent `needs` = a pure sealed snapshot. v1 defines one.
export type GameCapability = "live-session-events";

export type GameSource =
  | { kind: "session"; agent: string; project?: string; sessionId: string; summary: string }
  | { kind: "skill"; skillName: string; sourceId?: string }
  | { kind: "project"; path: string; flavor: string };

export interface GameArtifact {
  type: "game";
  name: string;             // slug, e.g. "auth-bugfix-replay"
  title: string;            // display, e.g. "The Great Auth Bug Hunt"
  genre: GameGenre;
  html: string;             // the pre-bundled, self-contained game
  poster?: string;          // data-URI thumbnail (the preview gate's screenshot)
  createdFrom: GameSource;  // provenance reference + summary — NOT the raw source
  engineVersion: string;    // scaffold/genre version, for future migration
  needs?: GameCapability[]; // declared, read-only; host decides. Absent = pure snapshot.
  meta?: { controls?: string; estPlaySeconds?: number };
}
```

Add `GameArtifact` to the `GemArtifact` union (line 97):

```ts
export type GemArtifact = SkillArtifact | McpServerArtifact | InstructionsArtifact | HookArtifact | ChannelArtifact | SubagentArtifact | GameArtifact | ReferenceArtifact;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- gameArtifact`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/types.ts src/gem/__tests__/gameArtifact.test.ts
git commit -m "$(printf 'feat(model): add GameArtifact to the gem artifact union\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Add the `game` cut to the classifier

**Files:**
- Modify: `packages/model/src/gemTypes.ts:24-36` (`BUILTIN_CUTS`)
- Test: `src/gem/__tests__/gemTypes.test.ts:38-44` (extend existing assertions) + new `deriveCut` case

**Interfaces:**
- Consumes: `GameArtifact` (Task 1).
- Produces: a `game` cut in `BUILTIN_CUTS` (`id:"game"`, `gemstone:"Ruby"`, `order:45`), matching gems whose every artifact is `type==="game"`. `deriveCut(BUILTIN_CUTS, gameOnlyGem) === "game"`.

- [ ] **Step 1: Write the failing test**

In `src/gem/__tests__/gemTypes.test.ts`, add a `game` helper (after line 10) and cases. Add helper:

```ts
const game = (name: string): GemArtifact => ({
  type: "game", name, title: name, genre: "replay",
  html: "<!doctype html>", engineVersion: "1",
  createdFrom: { kind: "session", agent: "claude", sessionId: "s", summary: "x" },
});
```

Add a `deriveCut` case (inside the `describe("deriveCut")` block):

```ts
  it("game — only game artifacts", () => {
    expect(d(gem([game("a"), game("b")]))).toBe("game");
  });
  it("kit — a game mixed with a skill is not a game cut", () => {
    expect(d(gem([game("a"), skill("b")]))).toBe("kit");
  });
```

Update the `BUILTIN_CUTS` assertion (lines 39-43) to expect 7 cuts with `game` before `skill`:

```ts
  it("has the 7 cuts with stable ids, gemstones, and ascending order", () => {
    expect(BUILTIN_CUTS.map((c) => c.id)).toEqual(["playbook", "setup", "integration", "guide", "game", "skill", "kit"]);
    expect(BUILTIN_CUTS.find((c) => c.id === "playbook")!.gemstone).toBe("Pearl");
    expect(BUILTIN_CUTS.find((c) => c.id === "game")!.gemstone).toBe("Ruby");
    expect(BUILTIN_CUTS.find((c) => c.id === "kit")!.gemstone).toBe("Amethyst");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- gemTypes`
Expected: FAIL — `game` cut absent; array is 6 ids, no `"game"`.

- [ ] **Step 3: Add the cut**

In `packages/model/src/gemTypes.ts`, insert into `BUILTIN_CUTS` between the `guide` (order 40) and `skill` (order 50) entries:

```ts
  { id: "game", label: "Game", gemstone: "Ruby", order: 45,
    matches: (g) => g.artifacts.length > 0 && g.artifacts.every((a) => a.type === "game") },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- gemTypes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/gemTypes.ts src/gem/__tests__/gemTypes.test.ts
git commit -m "$(printf 'feat(model): add the Ruby "game" cut to the classifier\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Mirror the `game` cut in the marketplace display vocabulary

**Files:**
- Modify: `packages/marketplace/src/gems/cuts.ts:7-14` (`CUTS`)
- Test: `packages/marketplace/src/gems/cuts.test.ts` (add a case)

**Interfaces:**
- Consumes: none (mirrors Task 2's ids/labels; marketplace cannot import `@agentgem/model`).
- Produces: `CUTS.game` (`label:"Game"`, `gemstone:"Ruby"`, Ruby tint) so `cutMeta("game")` renders a badge.

> Note: the marketplace SPA runs its own vitest, not the root one. Run its tests from the package: `pnpm --filter @agentgem/marketplace test` (or the marketplace's documented test command). This task's commit stands alone.

- [ ] **Step 1: Write the failing test**

In `packages/marketplace/src/gems/cuts.test.ts`, add:

```ts
it("has a Ruby game cut", () => {
  expect(CUTS.game).toEqual({ label: "Game", gemstone: "Ruby", bg: "#f7dede", fg: "#b23a48" });
  expect(cutMeta("game")?.gemstone).toBe("Ruby");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/marketplace test -- cuts`
Expected: FAIL — `CUTS.game` is undefined.

- [ ] **Step 3: Add the entry**

In `packages/marketplace/src/gems/cuts.ts`, add to the `CUTS` object (after the `skill` line):

```ts
  game: { label: "Game", gemstone: "Ruby", bg: "#f7dede", fg: "#b23a48" },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/marketplace test -- cuts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/gems/cuts.ts packages/marketplace/src/gems/cuts.test.ts
git commit -m "$(printf 'feat(marketplace): Ruby game cut badge\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Scaffold `packages/play` and the static "self-contained" gate

**Files:**
- Create: `packages/play/package.json`, `packages/play/tsconfig.json`, `packages/play/src/index.ts`, `packages/play/src/gameGate.ts`
- Modify: root `tsconfig.json` (`references` array), root `package.json` (dependencies)
- Test: `src/play/__tests__/gameGate.static.test.ts` (new)

**Interfaces:**
- Consumes: nothing yet.
- Produces: `interface GateResult { ok: boolean; failures: string[] }`; `interface GateOptions { maxBytes?: number; allowedNeeds?: readonly string[] }`; `function staticGate(html: string, opts?: GateOptions): GateResult`. Later: `gameGate()` (Task 5) composes this.

- [ ] **Step 1: Create the package skeleton**

`packages/play/package.json`:

```json
{
  "name": "@agentgem/play",
  "version": "0.1.0",
  "description": "Play authoring engine — game generation, validation gate, and source extraction.",
  "license": "MIT",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsc -b" },
  "dependencies": {
    "@agentgem/model": "workspace:*",
    "jsdom": "^24"
  },
  "devDependencies": {
    "@types/jsdom": "^21"
  }
}
```

`packages/play/tsconfig.json` (mirror `packages/model/tsconfig.json`, add a reference to model):

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2022"],
    "types": ["node"],
    "strict": true,
    "strictPropertyInitialization": false,
    "useUnknownInCatchVariables": false,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "composite": true,
    "declaration": true,
    "rootDir": "src",
    "outDir": "dist",
    "incremental": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"],
  "references": [{ "path": "../model" }]
}
```

`packages/play/src/index.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
export { staticGate, type GateResult, type GateOptions } from "./gameGate.js";
```

In the root `tsconfig.json` `references` array, add `{ "path": "packages/play" }` (end of the array).

In the root `package.json` `dependencies`, add `"@agentgem/play": "workspace:*"` (so root `src/play/__tests__` can import it).

- [ ] **Step 2: Install and write the failing test**

Run: `pnpm install` (links the new workspace package + jsdom).

Create `src/play/__tests__/gameGate.static.test.ts`:

```ts
// src/play/__tests__/gameGate.static.test.ts
import { describe, it, expect } from "vitest";
import { staticGate } from "@agentgem/play";

const sealed = `<!doctype html><html><head><style>body{margin:0}</style></head>
<body><canvas></canvas><script>const x=1;</script></body></html>`;

describe("staticGate", () => {
  it("passes a self-contained bundle (inline JS/CSS, no external refs)", () => {
    expect(staticGate(sealed)).toEqual({ ok: true, failures: [] });
  });

  it("fails on an external script src", () => {
    const r = staticGate(`<script src="https://cdn.example/x.js"></script>`);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("external"))).toBe(true);
  });

  it("fails on a network call in inline script", () => {
    const r = staticGate(`<script>fetch("http://localhost:9999/api")</script>`);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("network"))).toBe(true);
  });

  it("allows data: URIs (they are self-contained)", () => {
    expect(staticGate(`<img src="data:image/png;base64,AAAA">${sealed}`).ok).toBe(true);
  });

  it("fails when the bundle exceeds the size budget", () => {
    const big = sealed + "<!--" + "x".repeat(2_000_000) + "-->";
    const r = staticGate(big, { maxBytes: 1_000_000 });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("size"))).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- gameGate.static`
Expected: FAIL — `staticGate` not implemented.

- [ ] **Step 4: Implement `staticGate`**

`packages/play/src/gameGate.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Server-side validation gate. Tier-1: static "self-contained" checks that keep a game bundle
// sealed and shareable (no network, no external assets), independent of any agent self-report.

export interface GateResult { ok: boolean; failures: string[] }
export interface GateOptions {
  maxBytes?: number;                 // default 1.5 MB — archives/shares well
  allowedNeeds?: readonly string[];  // recognized capability names (for the needs sanity check)
}

const DEFAULT_MAX_BYTES = 1_500_000;

// External-resource patterns. `data:` is allowed (self-contained); http(s)/protocol-relative are not.
const EXTERNAL_ATTR = /\b(?:src|href)\s*=\s*["'](?!data:|#)(?:https?:)?\/\//i;
const BARE_IMPORT = /\bimport\s+[^;]*?from\s+["'](?!data:)[^"']+["']/;
const NETWORK_CALL = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|navigator\.sendBeacon)\b/;

export function staticGate(html: string, opts: GateOptions = {}): GateResult {
  const failures: string[] = [];
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  if (Buffer.byteLength(html, "utf8") > maxBytes) {
    failures.push(`bundle exceeds size budget (${maxBytes} bytes)`);
  }
  if (EXTERNAL_ATTR.test(html)) {
    failures.push("references an external resource (src/href to a remote URL)");
  }
  if (BARE_IMPORT.test(html)) {
    failures.push("uses an external module import");
  }
  if (NETWORK_CALL.test(html)) {
    failures.push("attempts a network call (fetch/XHR/WebSocket/…) — games must be sealed");
  }

  return { ok: failures.length === 0, failures };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- gameGate.static`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/play src/play/__tests__/gameGate.static.test.ts tsconfig.json package.json pnpm-lock.yaml
git commit -m "$(printf 'feat(play): scaffold packages/play with the static self-contained gate\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: Add the jsdom load-smoke to the gate

**Files:**
- Modify: `packages/play/src/gameGate.ts` (add `gameGate`), `packages/play/src/index.ts` (export it)
- Test: `src/play/__tests__/gameGate.smoke.test.ts` (new)

**Interfaces:**
- Consumes: `staticGate` (Task 4).
- Produces: `async function gameGate(html: string, opts?: GateOptions): Promise<GateResult>` — runs `staticGate`, then executes inline scripts in a jsdom context and reports any uncaught throw in the first tick.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/gameGate.smoke.test.ts`:

```ts
// src/play/__tests__/gameGate.smoke.test.ts
import { describe, it, expect } from "vitest";
import { gameGate } from "@agentgem/play";

const good = `<!doctype html><body><canvas id="c"></canvas>
<script>const el=document.getElementById("c"); el.setAttribute("data-ok","1");</script></body>`;

describe("gameGate (static + jsdom smoke)", () => {
  it("passes a bundle whose inline script runs without throwing", async () => {
    const r = await gameGate(good);
    expect(r).toEqual({ ok: true, failures: [] });
  });

  it("fails when the inline script throws on load", async () => {
    const r = await gameGate(`<!doctype html><body><script>throw new Error("boom")</script></body>`);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("boom") || f.includes("threw"))).toBe(true);
  });

  it("still enforces the static checks (short-circuits on a network call)", async () => {
    const r = await gameGate(`<script>fetch("http://x/")</script>`);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("network"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- gameGate.smoke`
Expected: FAIL — `gameGate` not exported.

- [ ] **Step 3: Implement `gameGate`**

Append to `packages/play/src/gameGate.ts`:

```ts
import { JSDOM, VirtualConsole } from "jsdom";

// Tier-1 continued: a load-smoke. Execute the bundle's inline scripts in a jsdom DOM (no network:
// resources are not fetched) and catch an uncaught throw in the first tick. jsdom cannot see a blank
// canvas — visual correctness is the human preview's job (Tier-2) — but it reliably catches the large
// class of "broken on load" failures the self-repair loop iterates against.
export async function gameGate(html: string, opts: GateOptions = {}): Promise<GateResult> {
  const staticResult = staticGate(html, opts);
  if (!staticResult.ok) return staticResult; // short-circuit; don't execute a non-sealed bundle

  const failures: string[] = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (err: Error) => failures.push(`inline script threw: ${err.message}`));

  try {
    const dom = new JSDOM(html, {
      runScripts: "dangerously", // execute inline <script>; jsdom does NOT fetch external resources
      resources: undefined,       // never load external resources
      virtualConsole: vc,
      pretendToBeVisual: true,    // provides requestAnimationFrame so canvas game loops don't throw
    });
    await new Promise((r) => setTimeout(r, 0)); // let the first tick run
    dom.window.close();
  } catch (err) {
    failures.push(`bundle failed to load: ${(err as Error).message}`);
  }

  return { ok: failures.length === 0, failures };
}
```

Update `packages/play/src/index.ts`:

```ts
export { staticGate, gameGate, type GateResult, type GateOptions } from "./gameGate.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- gameGate.smoke`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/gameGate.ts packages/play/src/index.ts src/play/__tests__/gameGate.smoke.test.ts
git commit -m "$(printf 'feat(play): jsdom load-smoke in the validation gate\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: Prove the union extension is repo-safe (games ignored by materialize)

**Files:**
- Test: `src/gem/__tests__/gameMaterialize.test.ts` (new)
- Modify: any consumer `tsc -b` flags (expected: few or none, given `targets.ts` uses selective `.filter`)

**Interfaces:**
- Consumes: `GameArtifact` (Task 1), the model's target builder from `@agentgem/model`.
- Produces: confidence that a gem containing a game artifact materializes without error and does not emit the game to a `.claude/` target (games run in Play, not on agent targets).

- [ ] **Step 1: Full build to enumerate any union breakage**

Run: `pnpm build`
Expected: SUCCESS. If `tsc -b` reports errors at a consumer switching over artifact types, fix each by adding a `game` branch that **skips** (games are not materialized to agent targets) — do NOT force game into skill/mcp handling. Re-run until green. (Given `packages/model/src/targets.ts` selects via `.filter((a): a is X => a.type === "…")`, unknown kinds are already ignored; breakage is expected to be minimal.)

- [ ] **Step 2: Write the failing test**

Find the model's target-build entry (e.g. in `packages/model/src/targets.ts` / exported from `@agentgem/model`; confirm the exact exported function name via `grep -n "export function" packages/model/src/targets.ts`). Create `src/gem/__tests__/gameMaterialize.test.ts` — replace `buildClaudeTarget` with the real exported builder name if different:

```ts
// src/gem/__tests__/gameMaterialize.test.ts
import { describe, it, expect } from "vitest";
import type { Gem, GemArtifact } from "@agentgem/model";
// import { buildClaudeTarget } from "@agentgem/model"; // ← confirm the real export name

const gameGem: Gem = {
  name: "g", createdFrom: "t", checks: [], requiredSecrets: [],
  artifacts: [{
    type: "game", name: "replay", title: "Replay", genre: "replay",
    html: "<!doctype html>", engineVersion: "1",
    createdFrom: { kind: "session", agent: "claude", sessionId: "s", summary: "x" },
  } satisfies GemArtifact],
};

describe("materialize ignores game artifacts", () => {
  it("does not throw and emits no files for a game-only gem", () => {
    // const out = buildClaudeTarget(gameGem);
    // expect(Object.keys(out.files)).toHaveLength(0); // no .claude/ output for a game
    expect(gameGem.artifacts[0].type).toBe("game"); // placeholder assertion until the builder is wired
  });
});
```

> The implementer MUST replace the commented lines with the real builder import + assertion (uncomment, fix the name, assert the game produces no target files). Leaving them commented is a task failure.

- [ ] **Step 3: Run test to verify it fails, then wire the real builder**

Run: `pnpm test -- gameMaterialize`
Expected: initially trivially PASS with the placeholder; the implementer replaces the placeholder with the real builder call. If the builder throws on an unknown kind, add the skipping `game` branch (Step 1) so it returns no files, then the assertion `toHaveLength(0)` passes.

- [ ] **Step 4: Full test suite green**

Run: `pnpm test`
Expected: PASS across `test` (tsc -b compiles all references, then vitest runs). This is the gate that the union extension broke nothing repo-wide.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(printf 'test(play): game artifacts are ignored by target materialize; suite green\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## What Plans 2 and 3 will cover (not this plan)

- **Plan 2 — Authoring engine:** `packages/play` `genres.ts`, `scaffolds/<genre>.html`, `sourceContext.ts` (session/skill/project → `GenerationInput`), `generateGame.ts` (ACP self-repair loop driving `gameGate`), and the core `POST /api/play/generate` SSE route. Testable with a mocked ACP driver.
- **Plan 3 — Console surface:** `packages/console/src/panels/Play/` (`Composer`, `Arcade`, `Runner`), the sealed-iframe runtime (reusing `panels/Watch/sandboxDoc.ts`), the consent-gated capability broker (dormant), and sharing/publish wiring + the game-content consent line.

## Self-Review

- **Spec coverage (Plan 1 scope):** `game` ArtifactType + `GameArtifact` (Task 1) ✓; `game` cut / gemstone (Tasks 2–3) ✓; two-tier gate Tier-1 static + jsdom (Tasks 4–5) ✓; union-safety across the monorepo (Task 6) ✓. Tier-2 preview, generation, broker, sharing are explicitly Plans 2–3.
- **Placeholder scan:** Task 6's test ships with commented lines the implementer MUST wire to the real exported builder — called out explicitly as a required action and a task-failure-if-skipped, because the exact export name must be confirmed against source rather than guessed. No other placeholders.
- **Type consistency:** `GateResult`/`GateOptions`/`staticGate`/`gameGate` names match across Tasks 4–5 and `index.ts`. `GameArtifact` fields used in Tasks 2/6 tests match the Task 1 definition (`title`, `genre`, `html`, `engineVersion`, `createdFrom`). Cut id `"game"`, gemstone `"Ruby"`, order `45` consistent across Tasks 2–3 and both cut definitions.

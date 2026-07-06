# Play — Miniapps Registry + Dual-Write + Gate (Plan 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store miniapps/games in a git-backed registry at `~/.agentgem/miniapps/<name>/<name>.html`, dual-written as a `game` gem, admission-gated by `gameGate` before every commit, with `save`/`list`/`publish` (git push) routes — plus the genre/scaffold/source foundation that seeds the Chat studio (Plan 2b).

**Architecture:** `packages/play` gains: a genre registry + sealed HTML scaffolds + a single genre-aware `sourceContext` (the studio seed); a thin `child_process` **git wrapper**; and a **miniapps store** that writes `<name>/<name>.html` + `meta.json` into the `~/.agentgem/miniapps/` git repo AND `createWorkspace`s a matching `game` gem (dual-write), refusing to commit anything that fails `gameGate`. Core adds a `PlayController` with `POST /api/play/save`, `GET /api/play/miniapps`, `POST /api/play/publish`. All logic is testable in a temp dir (`AGENTGEM_HOME` override); no live agent runs.

**Tech Stack:** TypeScript (nodenext, strict), pnpm workspaces, `tsc -b`, vitest (compiled `dist/**/__tests__`), `node:child_process` (git), `@agentgem/archive`/`@agentgem/base` (gem persistence), `@agentgem/play` (Plan 1's `gameGate`), agentback controllers.

## Global Constraints

- **Node floor: >= 24.** CI runs `test (24)` + `test (26)`; CI runs `pnpm build` before `pnpm test`.
- **Tests at repo-root `src/<area>/__tests__/*.test.ts`** (compiled to root `dist`, run by root vitest). Package logic in `packages/play/src`; its tests go in `src/play/__tests__/` importing `@agentgem/play`.
- **Run the FULL `pnpm test` before committing each task** (a sibling test with a hardcoded count/boot assertion can break even when your focused test passes — this bit Plan 1). The only acceptable pre-existing failure is `dist/__tests__/consoleMount.test.js` (needs the console SPA build; CI runs `pnpm build` first).
- **`tsc -b` is the source of truth for type breakage.**
- **Home convention:** `miniappsRoot()` = `join(process.env.AGENTGEM_HOME ?? join(homedir(), ".agentgem"), "miniapps")` — the SAME convention as `workspacesRoot()` (`packages/base/src/workspaces.ts:40`), so `~/.agentgem/miniapps/` and `~/.agentgem/workspaces/` are siblings and dual-write stays consistent. Do NOT use `agentgemHome()` (that treats `AGENTGEM_HOME` as the home *root* and callers append `.agentgem`, a different convention).
- **Name validation:** every miniapp name is validated with `safePathSegment` (from `@agentgem/model`) before being joined under `miniappsRoot()` — reject separators/`.`/`..` — mirroring `workspaceName` (`packages/base/src/workspaces.ts:45`).
- **Gate before commit:** `gameGate(html)` MUST pass before a miniapp is written/committed. A failing bundle is never persisted.
- **No new dependency for git:** shell out via `node:child_process.spawn("git", …)`. Git must be on PATH (document it; degrade with a clear error if absent).
- **Commits:** author `Raymond Feng <raymond@ninemind.ai>`; end every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Landmarks (verified)

- Plan 1 (landed): `GameArtifact`/`GameGenre`/`GameCapability`/`GameSource` (`packages/model/src/types.ts:43-74`), `GameArtifactSchema` (`src/schemas.ts:91-116`), `gameGate(html)`/`staticGate(html)` (`packages/play/src/gameGate.ts`), archive round-trip for `GameArtifact`.
- Persistence: `createWorkspace(name, gem, {version?}): WorkspaceSummary` (`packages/base/src/workspaces.ts:84`), `workspaceDir(name)` (:52), `workspacesRoot()` (:40), `workspaceName(name)` (:45, validates via `safePathSegment`).
- Source readers (for `sourceContext`, used by the studio seed): `loadSessionTranscript(sessionId, agent): Promise<TranscriptView|null>` (`packages/insight/src/inspectSession.ts:294`); `introspectAll(dir, projects)` → inventory `.skills: SkillArtifact[]` (`@agentgem/capture`); `suggestTestbed(root)` / `discoverProjects(dirs)` (`packages/testbed/src/testbedFlavors.ts:167,186`).
- Controllers registered at `src/index.ts:113-117` (`app.restController(...)`).
- **Not this plan:** Chat-studio wiring (Plan 2b), console Play surface (Plan 3).

---

### Task 1: Genre registry (`genres.ts`)

**Files:**
- Create: `packages/play/src/genres.ts`
- Modify: `packages/play/src/index.ts`
- Test: `src/play/__tests__/genres.test.ts`

**Interfaces:**
- Produces: `interface GenreSpec { id: GameGenre; sourceKind: GameSource["kind"]; title: string; scaffold: string; guidance: string }`; `const GENRES: Record<GameGenre, GenreSpec>`; `function genreFor(id: string): GenreSpec` (throws on unknown).

- [ ] **Step 1: Write the failing test**

```ts
// src/play/__tests__/genres.test.ts
import { describe, it, expect } from "vitest";
import { GENRES, genreFor } from "@agentgem/play";

describe("genres", () => {
  it("has the three v1 genres, each mapping to its source kind", () => {
    expect(Object.keys(GENRES).sort()).toEqual(["project-fun", "replay", "skill-run"]);
    expect(GENRES.replay.sourceKind).toBe("session");
    expect(GENRES["skill-run"].sourceKind).toBe("skill");
    expect(GENRES["project-fun"].sourceKind).toBe("project");
  });
  it("genreFor resolves a known genre and throws on unknown", () => {
    expect(genreFor("replay").id).toBe("replay");
    expect(() => genreFor("bogus")).toThrow(/unknown genre/);
  });
  it("every genre names a non-empty scaffold and guidance", () => {
    for (const g of Object.values(GENRES)) {
      expect(g.scaffold.length).toBeGreaterThan(0);
      expect(g.guidance.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm test -- genres` → FAIL (`GENRES` not exported).

- [ ] **Step 3: Implement `genres.ts`**

```ts
// packages/play/src/genres.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The genre registry — the one place that knows what each genre is FOR. Adding a genre (or a future
// kind like a non-game miniapp) is one entry here + one scaffold + one sourceContext branch.
import type { GameGenre, GameSource } from "@agentgem/model";

export interface GenreSpec {
  id: GameGenre;
  sourceKind: GameSource["kind"];
  title: string;
  scaffold: string;   // scaffold id (see scaffolds.ts)
  guidance: string;   // genre-specific prompt guidance used to seed the studio
}

export const GENRES: Record<GameGenre, GenreSpec> = {
  replay: {
    id: "replay", sourceKind: "session", title: "Session Replay", scaffold: "replay",
    guidance:
      "Build a short, animated, playable replay of the coding session in the DATA: a timeline the player " +
      "advances, surfacing the key moments (tool calls, edits, errors, the fix). Delightful, not a log dump.",
  },
  "skill-run": {
    id: "skill-run", sourceKind: "skill", title: "Skill Run", scaffold: "skill-run",
    guidance:
      "Build a playable challenge that exercises the SKILL in the DATA: the player practices or is quizzed on " +
      "the skill's triggers and steps. Short rounds; reward correct application.",
  },
  "project-fun": {
    id: "project-fun", sourceKind: "project", title: "Project Fun", scaffold: "project-fun",
    guidance:
      "Build a light, themed mini-game seeded by the PROJECT in the DATA (name, flavor, notable files). Theme " +
      "the visuals and copy to the project; gameplay can be simple.",
  },
};

export function genreFor(id: string): GenreSpec {
  const spec = (GENRES as Record<string, GenreSpec>)[id];
  if (!spec) throw new Error(`unknown genre '${id}'`);
  return spec;
}
```

Add to `packages/play/src/index.ts`:
```ts
export { GENRES, genreFor, type GenreSpec } from "./genres.js";
```

- [ ] **Step 4: Run test to verify it passes** — `pnpm test -- genres` → PASS (3).

- [ ] **Step 5: Commit**
```bash
git add packages/play/src/genres.ts packages/play/src/index.ts src/play/__tests__/genres.test.ts
git commit -m "$(printf 'feat(play): genre registry (replay/skill-run/project-fun)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Sealed scaffolds (`scaffolds.ts`)

**Files:**
- Create: `packages/play/src/scaffolds.ts`
- Modify: `packages/play/src/index.ts`
- Test: `src/play/__tests__/scaffolds.test.ts`

**Interfaces:**
- Consumes: `GENRES` (Task 1), `gameGate` (Plan 1).
- Produces: `function scaffoldFor(scaffoldId: string): string` (throws on unknown). Scaffolds are inline TS string constants (survive `tsc`→`dist`, no fs paths).

- [ ] **Step 1: Write the failing test**

```ts
// src/play/__tests__/scaffolds.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldFor, gameGate, GENRES } from "@agentgem/play";

describe("scaffolds", () => {
  it("scaffoldFor throws on unknown", () => { expect(() => scaffoldFor("nope")).toThrow(/unknown scaffold/); });
  it("every genre's scaffold passes the gate empty (sealed + runs clean)", async () => {
    for (const g of Object.values(GENRES)) expect(await gameGate(scaffoldFor(g.scaffold))).toEqual({ ok: true, failures: [] });
  });
  it("scaffolds carry the agent-editable marker", () => { expect(scaffoldFor("replay")).toContain("AGENTGEM:GAME-LOGIC"); });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm test -- scaffolds` → FAIL.

- [ ] **Step 3: Implement `scaffolds.ts`**

```ts
// packages/play/src/scaffolds.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Sealed HTML scaffolds — runnable starting points the studio agent writes into. Inline everything
// (no external src/href/fetch; data: assets only) so a scaffold passes gameGate before the agent
// touches it. The agent replaces the block between the AGENTGEM:GAME-LOGIC markers. TS string
// constants so they compile into dist (no fs paths).
function sealedTemplate(title: string, subtitle: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  html,body { height:100%; margin:0; background:#0d1117; color:#e8edf4; font:16px/1.4 system-ui, sans-serif; overflow:hidden; }
  #stage { position:fixed; inset:0; display:grid; place-items:center; }
  canvas { max-width:100%; max-height:100%; }
  #hud { position:fixed; top:12px; left:12px; font:600 14px system-ui; opacity:.85; }
</style></head>
<body>
  <div id="hud">${subtitle}</div>
  <div id="stage"><canvas id="c" width="640" height="400"></canvas></div>
  <script>
  (function () {
    "use strict";
    const canvas = document.getElementById("c");
    const ctx = canvas.getContext("2d");
    const dataEl = document.getElementById("game-data");
    const DATA = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
    // ==== AGENTGEM:GAME-LOGIC START ====
    let t = 0;
    function frame() {
      ctx.fillStyle = "#0d1117"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#3b82f6"; ctx.font = "20px system-ui";
      ctx.fillText("${title}", 24, 40 + Math.sin(t / 20) * 4);
      t++; requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    // ==== AGENTGEM:GAME-LOGIC END ====
  })();
  </script>
</body></html>`;
}

const SCAFFOLDS: Record<string, string> = {
  replay: sealedTemplate("Session Replay", "▶ replay"),
  "skill-run": sealedTemplate("Skill Run", "⚙ practice"),
  "project-fun": sealedTemplate("Project Fun", "★ play"),
};

export function scaffoldFor(scaffoldId: string): string {
  const html = SCAFFOLDS[scaffoldId];
  if (!html) throw new Error(`unknown scaffold '${scaffoldId}'`);
  return html;
}
```

Add to `index.ts`: `export { scaffoldFor } from "./scaffolds.js";`

- [ ] **Step 4: Run test to verify it passes** — `pnpm test -- scaffolds` → PASS (3). If the gate flags a scaffold, fix the scaffold (it MUST be gate-clean).

- [ ] **Step 5: Commit**
```bash
git add packages/play/src/scaffolds.ts packages/play/src/index.ts src/play/__tests__/scaffolds.test.ts
git commit -m "$(printf 'feat(play): sealed genre scaffolds (gate-clean starting points)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Source extraction (`sourceContext.ts`)

**Files:**
- Create: `packages/play/src/sourceContext.ts`
- Modify: `packages/play/src/index.ts`
- Test: `src/play/__tests__/sourceContext.test.ts`

**Interfaces:**
- Consumes: `GameSource`, `GameGenre` (model).
- Produces: `interface GenerationInput { genre: GameGenre; brief: string; data: unknown; createdFrom: GameSource }`; `interface SourceReaders { loadSession; readSkill; readProject }` (injected for tests); `async function extractSource(source, readers): Promise<GenerationInput>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/play/__tests__/sourceContext.test.ts
import { describe, it, expect } from "vitest";
import { extractSource, type SourceReaders } from "@agentgem/play";
import type { GameSource } from "@agentgem/model";

const readers: SourceReaders = {
  loadSession: async (id) => ({ sessionId: id, meta: { msgs: 2 }, turns: [{ role: "assistant", text: "patched login" }] }),
  readSkill: async (name) => ({ name, content: "# " + name, trigger: { intent: "x", triggers: ["a"], antiTriggers: [] } }),
  readProject: async (path) => ({ path, flavor: "node", files: ["package.json"] }),
};

describe("extractSource", () => {
  it("session → replay", async () => {
    const src: GameSource = { kind: "session", agent: "claude", sessionId: "s1", summary: "auth" };
    const input = await extractSource(src, readers);
    expect(input.genre).toBe("replay");
    expect(input.createdFrom).toEqual(src);
    expect(JSON.stringify(input.data)).toContain("patched login");
  });
  it("skill → skill-run", async () => {
    const input = await extractSource({ kind: "skill", skillName: "brainstorming" }, readers);
    expect(input.genre).toBe("skill-run");
    expect(JSON.stringify(input.data)).toContain("brainstorming");
  });
  it("project → project-fun", async () => {
    const input = await extractSource({ kind: "project", path: "/p", flavor: "node" }, readers);
    expect(input.genre).toBe("project-fun");
    expect(JSON.stringify(input.data)).toContain("package.json");
  });
  it("throws when the session is missing", async () => {
    await expect(extractSource({ kind: "session", agent: "claude", sessionId: "gone", summary: "x" }, { ...readers, loadSession: async () => null })).rejects.toThrow(/session/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm test -- sourceContext` → FAIL.

- [ ] **Step 3: Implement `sourceContext.ts`**

```ts
// packages/play/src/sourceContext.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The ONE genre-aware seam: GameSource → a compact GenerationInput (a human brief + JSON data) that
// seeds the Chat studio. Readers are injected so this is unit-testable without disk/agents.
import type { GameSource, GameGenre } from "@agentgem/model";

export interface GenerationInput { genre: GameGenre; brief: string; data: unknown; createdFrom: GameSource }
export interface SessionData { sessionId: string; meta: unknown; turns: unknown }
export interface SkillData { name: string; content: string; trigger?: unknown }
export interface ProjectData { path: string; flavor: string; files: string[] }
export interface SourceReaders {
  loadSession(sessionId: string, agent: string): Promise<SessionData | null>;
  readSkill(name: string): Promise<SkillData | null>;
  readProject(path: string): Promise<ProjectData | null>;
}

export async function extractSource(source: GameSource, readers: SourceReaders): Promise<GenerationInput> {
  if (source.kind === "session") {
    const s = await readers.loadSession(source.sessionId, source.agent);
    if (!s) throw new Error(`session '${source.sessionId}' not found`);
    return { genre: "replay", createdFrom: source, data: s, brief: `Make a playable replay of this coding session (${source.summary}).` };
  }
  if (source.kind === "skill") {
    const k = await readers.readSkill(source.skillName);
    if (!k) throw new Error(`skill '${source.skillName}' not found`);
    return { genre: "skill-run", createdFrom: source, data: k, brief: `Make a playable challenge that exercises the skill "${source.skillName}".` };
  }
  const p = await readers.readProject(source.path);
  if (!p) throw new Error(`project '${source.path}' not found`);
  return { genre: "project-fun", createdFrom: source, data: p, brief: `Make a light themed mini-game seeded by the project at ${source.path} (${source.flavor}).` };
}
```

Add to `index.ts`: `export { extractSource, type GenerationInput, type SourceReaders } from "./sourceContext.js";`

- [ ] **Step 4: Run test to verify it passes** — `pnpm test -- sourceContext` → PASS (4).

- [ ] **Step 5: Commit**
```bash
git add packages/play/src/sourceContext.ts packages/play/src/index.ts src/play/__tests__/sourceContext.test.ts
git commit -m "$(printf 'feat(play): source extraction (session/skill/project -> GenerationInput)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Thin git wrapper (`git.ts`)

**Files:**
- Create: `packages/play/src/git.ts`
- Modify: `packages/play/src/index.ts`
- Test: `src/play/__tests__/git.test.ts`

**Interfaces:**
- Produces: `async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>`; `async function ensureRepo(dir: string): Promise<void>` (mkdir + `git init` if not already a repo, with a default identity so commits work in CI); `async function commitAll(dir: string, message: string): Promise<string | null>` (stage all, commit; returns the commit sha, or null if nothing to commit); `async function setRemote(dir: string, url: string): Promise<void>`; `async function push(dir: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/play/__tests__/git.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepo, commitAll, git } from "@agentgem/play";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mini-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("git wrapper", () => {
  it("ensureRepo initializes a repo idempotently", async () => {
    await ensureRepo(dir);
    await ensureRepo(dir); // second call is a no-op, must not throw
    const r = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    expect(r.stdout.trim()).toBe("true");
  });
  it("commitAll stages+commits and returns a sha; a clean tree returns null", async () => {
    await ensureRepo(dir);
    writeFileSync(join(dir, "a.txt"), "hello");
    const sha = await commitAll(dir, "add a");
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await commitAll(dir, "noop")).toBeNull(); // nothing changed
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm test -- play/__tests__/git` → FAIL.

- [ ] **Step 3: Implement `git.ts`**

```ts
// packages/play/src/git.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// A thin child_process git wrapper for the local miniapps registry. No dependency; git must be on
// PATH. Commits carry a fixed local identity so they work headless/in CI (a user can re-attribute).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", (e) => reject(new Error(`git not available on PATH: ${(e as Error).message}`)));
    p.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function run(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export async function ensureRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, ".git"))) return;
  await run(dir, ["init", "-q"]);
  // fixed local identity so commits succeed without global git config (CI/headless)
  await run(dir, ["config", "user.name", "AgentGem"]);
  await run(dir, ["config", "user.email", "miniapps@agentgem.local"]);
}

export async function commitAll(dir: string, message: string): Promise<string | null> {
  await run(dir, ["add", "-A"]);
  const status = await run(dir, ["status", "--porcelain"]);
  if (status === "") return null; // nothing staged/changed
  await run(dir, ["commit", "-q", "-m", message]);
  return run(dir, ["rev-parse", "HEAD"]);
}

export async function setRemote(dir: string, url: string): Promise<void> {
  const remotes = await run(dir, ["remote"]);
  if (remotes.split("\n").includes("origin")) await run(dir, ["remote", "set-url", "origin", url]);
  else await run(dir, ["remote", "add", "origin", url]);
}

export async function push(dir: string): Promise<void> {
  await run(dir, ["push", "-u", "origin", "HEAD"]);
}
```

Add to `index.ts`: `export { git, ensureRepo, commitAll, setRemote, push } from "./git.js";`

- [ ] **Step 4: Run test to verify it passes** — `pnpm test -- play/__tests__/git` → PASS (2).

- [ ] **Step 5: Commit**
```bash
git add packages/play/src/git.ts packages/play/src/index.ts src/play/__tests__/git.test.ts
git commit -m "$(printf 'feat(play): thin child_process git wrapper for the miniapps registry\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: Miniapps store + dual-write + gate (`miniapps.ts`)

**Files:**
- Create: `packages/play/src/miniapps.ts`
- Modify: `packages/play/src/index.ts`, `packages/play/package.json` (+`@agentgem/base`, `@agentgem/archive` if needed), `packages/play/tsconfig.json` (references)
- Test: `src/play/__tests__/miniapps.test.ts`

**Interfaces:**
- Consumes: `gameGate` (Plan 1); `ensureRepo`/`commitAll` (Task 4); `createWorkspace` (`@agentgem/base`); `safePathSegment` (`@agentgem/model`); `GameArtifact`/`GameSource`/`GameGenre`/`GameCapability` (model).
- Produces: `function miniappsRoot(): string`; `function miniappDir(name: string): string` (validated, jailed); `interface MiniappMeta { title; genre; createdFrom; engineVersion; needs? }`; `interface SaveMiniappInput { name; html; meta }`; `async function saveMiniapp(input): Promise<{ name; commit: string|null }>` (gate → write html+meta → git commit → dual-write game gem); `function listMiniapps(): { name; meta: MiniappMeta }[]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/play/__tests__/miniapps.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMiniapp, listMiniapps, miniappDir } from "@agentgem/play";
import { workspaceDir } from "@agentgem/base";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "My Game", genre: "project-fun" as const, createdFrom: { kind: "project" as const, path: "/p", flavor: "node" }, engineVersion: "1" };
const sealed = "<!doctype html><body><canvas></canvas><script>const x=1;</script></body>";

describe("miniapps store", () => {
  it("miniappDir is jailed under ~/.agentgem/miniapps and rejects traversal", () => {
    expect(miniappDir("g")).toContain(join("/.agentgem/miniapps", "g"));
    expect(() => miniappDir("../escape")).toThrow();
  });
  it("saveMiniapp gates, dual-writes (git file + gem), and lists", async () => {
    const res = await saveMiniapp({ name: "my-game", html: sealed, meta });
    expect(res.commit).toMatch(/^[0-9a-f]{7,40}$/);
    // git registry file
    expect(readFileSync(join(miniappDir("my-game"), "my-game.html"), "utf8")).toContain("canvas");
    expect(existsSync(join(miniappDir("my-game"), "meta.json"))).toBe(true);
    // dual-written gem
    expect(existsSync(join(workspaceDir("my-game"), "gem.json"))).toBe(true);
    // listable
    expect(listMiniapps().map((m) => m.name)).toContain("my-game");
  });
  it("refuses to save a bundle that fails the gate", async () => {
    await expect(saveMiniapp({ name: "bad", html: `<script>fetch("http://x/")</script>`, meta })).rejects.toThrow(/gate|sealed|network/i);
    expect(existsSync(miniappDir("bad"))).toBe(false);
  });
});
```

> Before implementing, confirm `workspaceDir` is exported from `@agentgem/base` (`grep -n "export function workspaceDir" packages/base/src/workspaces.ts`); if not, assert on `join(home, "workspaces", "my-game", "gem.json")` instead.

- [ ] **Step 2: Run test to verify it fails** — `pnpm test -- miniapps` → FAIL.

- [ ] **Step 3: Implement `miniapps.ts`**

```ts
// packages/play/src/miniapps.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The miniapps registry: ~/.agentgem/miniapps/ is a git repo; each miniapp is <name>/<name>.html +
// <name>/meta.json. saveMiniapp gates the bundle, writes it, git-commits, AND dual-writes a one-artifact
// `game` gem via createWorkspace so a miniapp is both a shareable HTML file and a marketplace gem.
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { safePathSegment } from "@agentgem/model";
import type { Gem, GameArtifact, GameGenre, GameSource, GameCapability } from "@agentgem/model";
import { createWorkspace } from "@agentgem/base";
import { gameGate } from "./gameGate.js";
import { ensureRepo, commitAll } from "./git.js";

export interface MiniappMeta {
  title: string; genre: GameGenre; createdFrom: GameSource; engineVersion: string; needs?: GameCapability[];
}
export interface SaveMiniappInput { name: string; html: string; meta: MiniappMeta }

export function miniappsRoot(): string {
  // SAME convention as workspacesRoot(): AGENTGEM_HOME is already the ~/.agentgem dir.
  return join(process.env.AGENTGEM_HOME ?? join(homedir(), ".agentgem"), "miniapps");
}
export function miniappDir(name: string): string {
  const safe = safePathSegment(name); // throws on separators / . / ..
  const dir = join(miniappsRoot(), safe);
  if (!dir.startsWith(miniappsRoot() + sep)) throw new Error("miniapp dir escaped the registry root");
  return dir;
}

export async function saveMiniapp(input: SaveMiniappInput): Promise<{ name: string; commit: string | null }> {
  const gate = await gameGate(input.html);
  if (!gate.ok) throw new Error(`miniapp failed the gate: ${gate.failures.join("; ")}`);
  const safe = safePathSegment(input.name);
  const root = miniappsRoot();
  await ensureRepo(root);                         // the registry is a git repo
  const dir = join(root, safe);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${safe}.html`), input.html);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(input.meta, null, 2));
  const commit = await commitAll(root, `save miniapp ${safe}`);

  // dual-write the matching game gem (marketplace-capable). If it already exists, that's fine.
  const artifact: GameArtifact = {
    type: "game", name: safe, title: input.meta.title, genre: input.meta.genre,
    html: input.html, createdFrom: input.meta.createdFrom, engineVersion: input.meta.engineVersion,
    ...(input.meta.needs ? { needs: input.meta.needs } : {}),
  };
  const gem: Gem = { name: safe, createdFrom: "play", artifacts: [artifact], checks: [], requiredSecrets: [] };
  try { createWorkspace(safe, gem); } catch { /* workspace exists → leave the prior gem; registry commit is source of truth */ }

  return { name: safe, commit };
}

export function listMiniapps(): { name: string; meta: MiniappMeta }[] {
  const root = miniappsRoot();
  if (!existsSync(root)) return [];
  const out: { name: string; meta: MiniappMeta }[] = [];
  for (const name of readdirSync(root)) {
    if (name === ".git") continue;
    const metaPath = join(root, name, "meta.json");
    if (!existsSync(metaPath)) continue;
    try { out.push({ name, meta: JSON.parse(readFileSync(metaPath, "utf8")) as MiniappMeta }); } catch { /* skip malformed */ }
  }
  return out;
}
```

Add to `index.ts`:
```ts
export { miniappsRoot, miniappDir, saveMiniapp, listMiniapps, type MiniappMeta, type SaveMiniappInput } from "./miniapps.js";
```
Ensure `packages/play/package.json` deps include `@agentgem/base` (and `@agentgem/model` already present) and `packages/play/tsconfig.json` references include `{ "path": "../base" }`; run `pnpm install`.

- [ ] **Step 4: Run test to verify it passes** — `pnpm test -- miniapps` → PASS (3). Then `pnpm test` (full).

- [ ] **Step 5: Commit**
```bash
git add packages/play src/play/__tests__/miniapps.test.ts pnpm-lock.yaml
git commit -m "$(printf 'feat(play): miniapps registry — gate + dual-write (git file + game gem)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: Play routes (`play.controller.ts`)

**Files:**
- Create: `src/play.controller.ts`
- Modify: `src/index.ts` (register), `src/schemas.ts` (schemas)
- Test: `src/__tests__/playRoutes.test.ts`

**Interfaces:**
- Consumes: `saveMiniapp`/`listMiniapps`/`miniappsRoot` (Task 5); `setRemote`/`push` (Task 4); `GameArtifactSchema` fields for the save body.
- Produces: `class PlayController` with `@post("/play/save")` (validate → `saveMiniapp`), `@get("/play/miniapps")` (list), `@post("/play/publish")` (`setRemote` if a url is given, then `push`).

- [ ] **Step 1: Add schemas** — in `src/schemas.ts`:
```ts
export const PlaySaveRequestSchema = z.object({
  name: z.string(), html: z.string(),
  meta: z.object({
    title: z.string(),
    genre: z.enum(["replay", "skill-run", "project-fun"]),
    createdFrom: GameArtifactSchema.shape.createdFrom,
    engineVersion: z.string().default("1"),
    needs: z.array(z.enum(["live-session-events", "local-project-access", "invoke-agent"])).optional(),
  }),
});
export const PlaySaveResponseSchema = z.object({ name: z.string(), commit: z.string().nullable() });
export const MiniappListSchema = z.object({ miniapps: z.array(z.object({ name: z.string(), title: z.string(), genre: z.string() })) });
export const PlayPublishRequestSchema = z.object({ remote: z.string().url().optional() });
export const PlayPublishResponseSchema = z.object({ ok: z.boolean() });
```

- [ ] **Step 2: Write the failing test**

```ts
// src/__tests__/playRoutes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayController } from "../play.controller.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "My Game", genre: "project-fun" as const, createdFrom: { kind: "project" as const, path: "/p", flavor: "node" }, engineVersion: "1" };

describe("PlayController", () => {
  it("save then miniapps lists it", async () => {
    const ctrl = new PlayController();
    const saved = await ctrl.save({ body: { name: "g1", html: "<!doctype html><body><canvas></canvas></body>", meta } });
    expect(saved.name).toBe("g1");
    const list = await ctrl.miniapps();
    expect(list.miniapps.map((m) => m.name)).toContain("g1");
  });
  it("save rejects a non-sealed bundle", async () => {
    const ctrl = new PlayController();
    await expect(ctrl.save({ body: { name: "bad", html: `<script>fetch("http://x/")</script>`, meta } })).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `pnpm test -- playRoutes` → FAIL.

- [ ] **Step 4: Implement `play.controller.ts`**

```ts
// src/play.controller.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Play JSON routes over the miniapps registry: save (gate + dual-write), list, publish (git push).
import { api, get, post, AgentError } from "@agentback/openapi";
import { z } from "zod";
import { saveMiniapp, listMiniapps, miniappsRoot, setRemote, push } from "@agentgem/play";
import { PlaySaveRequestSchema, PlaySaveResponseSchema, MiniappListSchema, PlayPublishRequestSchema, PlayPublishResponseSchema } from "./schemas.js";

@api({ basePath: "/api" })
export class PlayController {
  @post("/play/save", { body: PlaySaveRequestSchema, response: PlaySaveResponseSchema })
  async save(input: { body: z.infer<typeof PlaySaveRequestSchema> }): Promise<z.infer<typeof PlaySaveResponseSchema>> {
    try {
      return await saveMiniapp({ name: input.body.name, html: input.body.html, meta: input.body.meta });
    } catch (e) { throw new AgentError(400, (e as Error).message); }
  }

  @get("/play/miniapps", { response: MiniappListSchema })
  async miniapps(): Promise<z.infer<typeof MiniappListSchema>> {
    return { miniapps: listMiniapps().map((m) => ({ name: m.name, title: m.meta.title, genre: m.meta.genre })) };
  }

  @post("/play/publish", { body: PlayPublishRequestSchema, response: PlayPublishResponseSchema })
  async publish(input: { body: z.infer<typeof PlayPublishRequestSchema> }): Promise<z.infer<typeof PlayPublishResponseSchema>> {
    const root = miniappsRoot();
    try {
      if (input.body.remote) await setRemote(root, input.body.remote);
      await push(root);
      return { ok: true };
    } catch (e) { throw new AgentError(400, `publish failed: ${(e as Error).message}`); }
  }
}
```

Register in `src/index.ts` (after `app.restController(SourcesController);`):
```ts
app.restController(PlayController);
```
(add `import { PlayController } from "./play.controller.js";`).

- [ ] **Step 5: Run test to verify it passes** — `pnpm test -- playRoutes` → PASS (2). Then `pnpm test` (full).

- [ ] **Step 6: Commit**
```bash
git add src/play.controller.ts src/index.ts src/schemas.ts src/__tests__/playRoutes.test.ts
git commit -m "$(printf 'feat(play): play routes — save (gate+dual-write) / list / publish (git push)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 7: Full-suite green + wiring smoke

- [ ] **Step 1: Full build + suite** — `pnpm test`. PASS across the suite; only acceptable failure is the pre-existing `consoleMount` (console SPA not built locally). Fix anything else before proceeding.
- [ ] **Step 2: Confirm registration** — `grep -n "PlayController\|/api/play/" src/index.ts` → controller registered.
- [ ] **Step 3: Commit any fixes**
```bash
git add -A && git commit -m "$(printf 'test(play): full suite green with the miniapps registry wired\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Not this plan

- **Plan 2b — Chat studio wiring:** thread a validated per-miniapp `cwd` + seed `brief` (from `sourceContext`/scaffold) through `POST /api/chat` → `ChatManager.openChat` → a new connectFn wrapper (parallel to `src/index.ts:306-319`, preserving the no-raw-path invariant); console "open Chat in studio mode" on a miniapp; live preview via `Watch/sandboxDoc.ts`.
- **Plan 3 — Play console surface:** Composer (source→genre→open studio), Arcade (grid over `GET /api/play/miniapps`), permission chips + consent + brokers, publish/share UI.

## Self-Review

- **Spec coverage (this plan):** genre-agnostic genres (T1) ✓; sealed scaffolds (T2) ✓; single genre-aware `sourceContext` seed (T3) ✓; `child_process` git wrapper, no new dep (T4) ✓; `~/.agentgem/miniapps/` store + gate-before-commit + dual-write to the game gem (T5) ✓; `save`/`list`/`publish` routes (T6) ✓; full-suite gate (T7) ✓. Chat studio + console UI are Plans 2b/3.
- **Placeholder scan:** T5/T6 carry an explicit `grep`-and-confirm for `workspaceDir`'s export with a concrete fallback — a required action, not a vague TBD. No other placeholders.
- **Type consistency:** `MiniappMeta`/`SaveMiniappInput` fields match across T5/T6; `saveMiniapp` return `{ name, commit }` matches `PlaySaveResponseSchema`; `needs` enum matches Plan-1 `GameCapability`; `miniappsRoot()` uses the `workspacesRoot()` convention per Global Constraints; `commitAll` returns `string|null` and the schema/response mirror that nullable.
- **Test seams:** every task is testable in a temp dir via `AGENTGEM_HOME` override; git runs against real temp repos; no agent or network. `gameGate` is the real Plan-1 gate.

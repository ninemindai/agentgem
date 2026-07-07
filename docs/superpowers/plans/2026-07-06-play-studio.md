# Play — Chat Studio Wiring (Plan 2b of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse the ACP Chat tab as the miniapp studio — seed a miniapp from a source, then open a chat session **rooted in that miniapp's registry dir** with a studio brief, so the agent builds/edits `<name>.html` interactively. All while preserving the "request input can never redirect the agent to an arbitrary path" invariant.

**Architecture:** A `studio.ts` module in `packages/play` provides the pure, testable pieces: `seedStudio` (create + seed a miniapp dir from a `GameSource`), `studioBrief` (the agent instructions from a miniapp's meta), and `studioCwd` (the cwd allow-list guard). `PlayController` gains `POST /api/play/studio` (seed → returns the miniapp name). The existing `POST /api/chat` gains an optional `miniapp` field: the route resolves it to a **validated** cwd (via `miniappDir`, which rejects bad names) and a studio brief, and passes them to `ChatManager.openChat({ cwd, brief })`. The `index.ts` connect wrapper is relaxed from "always `chatCwd`" to "`studioCwd(requested, chatCwd)`" — a miniapp dir under `miniappsRoot()` passes; anything else falls back to the neutral chat cwd.

**Tech Stack:** TypeScript (nodenext, strict), pnpm workspaces, `tsc -b`, vitest, `@agentgem/play` (Plan 2 registry + gate), `@agentgem/insight`/`@agentgem/capture`/`@agentgem/testbed` (source readers), `@agentgem/run` (`ChatManager`), Express chat routes.

## Global Constraints

- **Node >= 24;** CI runs `test (24)`/`test (26)` and `pnpm build` before `pnpm test`.
- **Tests at repo-root `src/<area>/__tests__/*.test.ts`;** `packages/play` logic tested there via `@agentgem/play`. Run the FULL `pnpm test` before committing the route/index tasks (they touch app wiring).
- **`tsc -b` is the source of truth for type breakage.**
- **Security invariant (do not weaken):** a cwd derived from request input may ONLY be a validated miniapp dir. The route resolves `miniapp` (a name) via `miniappDir(name)` — which throws on any name that isn't already a clean single segment — and the `index.ts` wrapper additionally guards with `studioCwd` (allow only paths under `miniappsRoot()`, else fall back to `chatCwd`). Never pass a raw request path as cwd.
- **Reuse Plan 2:** `miniappDir`/`miniappsRoot`/`saveMiniapp`/`ensureRepo`/`commitAll`/`scaffoldFor`/`genreFor`/`extractSource`/`GENRES`/`MiniappMeta` from `@agentgem/play`. The miniapp on-disk layout is `<name>/<name>.html` + `<name>/meta.json` in the `~/.agentgem/miniapps/` git repo.
- **Commits:** author `Raymond Feng <raymond@ninemind.ai>`; end every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Landmarks (verified against current `origin/main`)

- Chat routes: `src/goldmine/chatRoutes.ts` — `interface ChatRouteDeps { manager: ChatManager; listAgents; buildBrief: () => Promise<string>; goldmineMcp }`; `registerChatRoutes(app, deps, guard)` (:58); `POST /api/chat` handler (:65-77) reads only `req.body.agentId`, calls `deps.manager.openChat({ agentId, brief, mcpServers })`.
- Session cwd forcing: `src/index.ts:305-321` — a `ChatManager` whose `connectFn` wraps `open(_cwd, opts) => conn.ctx.open(chatCwd, opts)`, `chatCwd = pathJoin(agentgemHome(), ".agentgem", "chat")`.
- `ChatManager.openChat({ agentId, brief, mcpServers?, descriptor?, cwd? }): Promise<string>` (`packages/run/src/chatSession.ts`) — `cwd` + `brief` are first-class; `cwd` reaches `conn.ctx.open(cwd)`.
- Source readers (for `defaultReaders`): `loadSessionTranscript(sessionId, agent): Promise<TranscriptView|null>` (`@agentgem/insight`, `packages/insight/src/inspectSession.ts:294`); `introspectAll(dir, projects)` → inventory `.skills: SkillArtifact[]` (`@agentgem/capture`); `suggestTestbed(root)` (`@agentgem/testbed`, `packages/testbed/src/testbedFlavors.ts:167`).
- **Not this plan:** the console Chat studio-mode UI + live preview iframe (Plan 3, with the rest of the console surface).

---

### Task 1: Studio module (`studio.ts`) — seed, brief, cwd guard

**Files:**
- Create: `packages/play/src/studio.ts`
- Modify: `packages/play/src/index.ts` (exports), `packages/play/src/sourceContext.ts` (append `defaultReaders`), `packages/play/package.json` (+`@agentgem/insight`,`@agentgem/capture`,`@agentgem/testbed`), `packages/play/tsconfig.json` (references)
- Test: `src/play/__tests__/studio.test.ts`

**Interfaces:**
- Consumes: `extractSource`/`SourceReaders`/`GenerationInput` (Plan 2), `genreFor`/`scaffoldFor` (Plan 2), `miniappDir`/`miniappsRoot`/`ensureRepo`/`commitAll` (Plan 2), `MiniappMeta` (Plan 2).
- Produces: `function studioCwd(requested: string | undefined, fallback: string): string`; `function studioBrief(name: string): string` (reads `<name>/meta.json`); `async function seedStudio(source: GameSource, readers: SourceReaders): Promise<{ name: string; brief: string }>`; `const defaultReaders: SourceReaders`.

- [ ] **Step 1: Write the failing test**

```ts
// src/play/__tests__/studio.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { seedStudio, studioBrief, studioCwd, miniappsRoot, type SourceReaders } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const readers: SourceReaders = {
  loadSession: async (id) => ({ sessionId: id, meta: { msgs: 1 }, turns: [{ role: "assistant", text: "patched login" }] }),
  readSkill: async (name) => ({ name, content: "# " + name, trigger: undefined }),
  readProject: async (path) => ({ path, flavor: "node", files: ["package.json"] }),
};

describe("studio", () => {
  it("studioCwd allows a miniapp dir and falls back for anything else", () => {
    const fallback = join(home, ".agentgem", "chat");
    const mini = join(miniappsRoot(), "g");
    expect(studioCwd(mini, fallback)).toBe(mini);
    expect(studioCwd("/etc", fallback)).toBe(fallback);
    expect(studioCwd(undefined, fallback)).toBe(fallback);
  });
  it("seedStudio creates + seeds a miniapp dir (scaffold + injected data + meta + commit)", async () => {
    const { name, brief } = await seedStudio({ kind: "project", path: "/p/my-proj", flavor: "node" }, readers);
    const dir = join(miniappsRoot(), name);
    const html = readFileSync(join(dir, `${name}.html`), "utf8");
    expect(html).toContain("AGENTGEM:GAME-LOGIC");   // scaffold present
    expect(html).toContain("game-data");             // DATA injected
    expect(existsSync(join(dir, "meta.json"))).toBe(true);
    expect(existsSync(join(miniappsRoot(), ".git"))).toBe(true); // committed to the registry repo
    expect(brief).toContain(name);
  });
  it("studioBrief reads meta and instructs editing the sealed html", async () => {
    const { name } = await seedStudio({ kind: "skill", skillName: "brainstorming" }, readers);
    const b = studioBrief(name);
    expect(b).toContain(`${name}.html`);
    expect(b.toLowerCase()).toContain("sealed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm test -- play/__tests__/studio` → FAIL.

- [ ] **Step 3: Implement `studio.ts`**

```ts
// packages/play/src/studio.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The Chat studio seam: seed a miniapp dir from a source (scaffold + injected DATA), build the agent's
// studio brief from its meta, and guard which cwd a chat session may adopt. studioCwd is the security
// gate: only a path under the miniapps registry (or the neutral fallback) is ever honored.
import { join, sep } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { GameSource } from "@agentgem/model";
import { extractSource, type SourceReaders } from "./sourceContext.js";
import { genreFor } from "./genres.js";
import { scaffoldFor } from "./scaffolds.js";
import { miniappDir, miniappsRoot, type MiniappMeta } from "./miniapps.js";
import { ensureRepo, commitAll } from "./git.js";

// Only allow a chat session to adopt a cwd that is inside the miniapps registry; otherwise the neutral
// fallback. The route resolves `miniapp` names via miniappDir (which rejects bad names) BEFORE this, so
// this is defense-in-depth against any raw path ever reaching conn.ctx.open().
export function studioCwd(requested: string | undefined, fallback: string): string {
  if (!requested) return fallback;
  return requested === fallback || requested.startsWith(miniappsRoot() + sep) ? requested : fallback;
}

// Derive a clean single-segment slug for a new miniapp from its source.
function slugFor(source: GameSource): string {
  const raw =
    source.kind === "session" ? `session-${source.sessionId}` :
    source.kind === "skill" ? source.skillName :
    (source.path.split(/[\\/]/).filter(Boolean).pop() ?? "project");
  const slug = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "miniapp";
}

// Inject the source DATA as an inert JSON <script> the game reads (mirrors the runtime convention).
function seedHtml(scaffold: string, data: unknown): string {
  const tag = `<script id="game-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
  return scaffold.replace("</body>", `${tag}</body>`);
}

export async function seedStudio(source: GameSource, readers: SourceReaders): Promise<{ name: string; brief: string }> {
  const input = await extractSource(source, readers);
  const name = slugFor(source);
  const dir = miniappDir(name);                       // validates the slug + jails the path
  const g = genreFor(input.genre);
  await ensureRepo(miniappsRoot());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.html`), seedHtml(scaffoldFor(g.scaffold), input.data));
  const meta: MiniappMeta = { title: name, genre: input.genre, createdFrom: input.createdFrom, engineVersion: "1" };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  await commitAll(miniappsRoot(), `seed miniapp ${name}`);
  return { name, brief: `${input.brief}\n\n${studioInstructions(name)}` };
}

function studioInstructions(name: string): string {
  return (
    `You are building the miniapp in ${name}.html (edit ONLY that file). It must stay a single ` +
    `self-contained, SEALED HTML file: inline all JS/CSS, use only data: URIs, and make NO network calls ` +
    `(no fetch/XHR/WebSocket/external src/href/import). Replace the block between the ` +
    `"AGENTGEM:GAME-LOGIC" markers. Read the JSON in <script id="game-data"> for the source content. ` +
    `The file must run without throwing on load.`
  );
}

export function studioBrief(name: string): string {
  const meta = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8")) as MiniappMeta;
  return `Continue building the "${meta.title}" miniapp (a ${meta.genre}).\n\n${studioInstructions(name)}`;
}
```

**PRE-FLIGHT CORRECTION:** `defaultReaders` goes in **root `src/play.readers.ts`**, NOT `packages/play` — root `src/` already depends on `@agentgem/insight`/`capture`/`testbed` (workspace:*), so `packages/play` stays lean with no new heavy deps and no cycle risk. `seedStudio`/`extractSource` take injected `SourceReaders`; the root controller/route provides `defaultReaders`. Do NOT add insight/capture/testbed to `packages/play/package.json` or `tsconfig.json`. Exports confirmed: `loadSessionTranscript` (@agentgem/insight barrel), `introspectAll(dir?, projects?)` → `.skills: SkillArtifact[]` (@agentgem/capture barrel), `suggestTestbed(root)` (@agentgem/testbed).

Create `src/play.readers.ts`:

```ts
// src/play.readers.ts
import type { SourceReaders } from "@agentgem/play";
import { loadSessionTranscript } from "@agentgem/insight";
import { introspectAll } from "@agentgem/capture";
import { suggestTestbed } from "@agentgem/testbed";
import { readdirSync } from "node:fs";
import type { AgentId } from "@agentgem/model";

export const defaultReaders: SourceReaders = {
  loadSession: async (sessionId, agent) => {
    const view = await loadSessionTranscript(sessionId, agent as AgentId);
    return view ? { sessionId: view.sessionId, meta: view.meta, turns: view.turns } : null;
  },
  readSkill: async (name) => {
    const inv = introspectAll(undefined, undefined);
    const s = inv.skills.find((k) => k.name === name);
    return s ? { name: s.name, content: s.content, trigger: s.trigger } : null;
  },
  readProject: async (path) => {
    const sug = suggestTestbed(path);
    if (!sug.looksLikeProject || !sug.flavor) return null;
    let files: string[] = [];
    try { files = readdirSync(path).slice(0, 40); } catch { files = []; }
    return { path, flavor: sug.flavor, files };
  },
};
```

Add to `packages/play/src/index.ts`:
```ts
export { studioCwd, studioBrief, seedStudio } from "./studio.js";
```
`defaultReaders` is exported from root `src/play.readers.ts` (imported by the controller + index.ts), NOT from `@agentgem/play`. No `packages/play` dep/tsconfig changes.

- [ ] **Step 4: Run test to verify it passes** — `pnpm test -- play/__tests__/studio` → PASS (3). Then `pnpm test` (full — the new cross-package deps must not create a cycle or break the build).

- [ ] **Step 5: Commit**
```bash
git add packages/play src/play/__tests__/studio.test.ts pnpm-lock.yaml
git commit -m "$(printf 'feat(play): studio seam — seedStudio / studioBrief / studioCwd guard + defaultReaders\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: `POST /api/play/studio` — seed a miniapp from a source

**Files:**
- Modify: `src/play.controller.ts` (add method), `src/schemas.ts` (schemas)
- Test: `src/__tests__/playStudio.test.ts`

**Interfaces:**
- Consumes: `seedStudio`/`defaultReaders` (Task 1).
- Produces: `PlayController.studio(input)` → `{ name: string }`, seeding a new miniapp dir from a `GameSource`.

- [ ] **Step 1: Add schemas** — in `src/schemas.ts`:
```ts
export const PlayStudioRequestSchema = z.object({ source: GameArtifactSchema.shape.createdFrom });
export const PlayStudioResponseSchema = z.object({ name: z.string() });
```

- [ ] **Step 2: Write the failing test**

```ts
// src/__tests__/playStudio.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayController } from "../play.controller.js";
import { miniappsRoot } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

describe("PlayController.studio", () => {
  it("seeds a miniapp dir from a project source", async () => {
    const ctrl = new PlayController();
    const res = await ctrl.studio({ body: { source: { kind: "project", path: "/tmp/does-not-matter-proj", flavor: "node" } } });
    expect(res.name.length).toBeGreaterThan(0);
    expect(existsSync(join(miniappsRoot(), res.name, `${res.name}.html`))).toBe(true);
  });
});
```

> The project reader (`defaultReaders.readProject`) calls `suggestTestbed(path)`; for a path that isn't a real project it returns null and `extractSource` throws. Use a path that `suggestTestbed` accepts, OR (simpler + hermetic) create a throwaway project dir in the test (`mkdirSync` + write a `package.json`) and pass THAT path. Confirm `suggestTestbed`'s "looks like a project" rule when implementing and make the fixture satisfy it.

- [ ] **Step 3: Run test to verify it fails** — `pnpm test -- playStudio` → FAIL.

- [ ] **Step 4: Implement the route** — add to `src/play.controller.ts`:

```ts
// imports
import { seedStudio, defaultReaders } from "@agentgem/play";
import { PlayStudioRequestSchema, PlayStudioResponseSchema } from "./schemas.js";

// method inside PlayController
@post("/play/studio", { body: PlayStudioRequestSchema, response: PlayStudioResponseSchema })
async studio(input: { body: z.infer<typeof PlayStudioRequestSchema> }): Promise<z.infer<typeof PlayStudioResponseSchema>> {
  try {
    const { name } = await seedStudio(input.body.source, defaultReaders);
    return { name };
  } catch (e) { throw new AgentError((e as Error).message, { status: 400 }); }
}
```

- [ ] **Step 5: Run test to verify it passes** — `pnpm test -- playStudio` → PASS. Then `pnpm test` (full).

- [ ] **Step 6: Commit**
```bash
git add src/play.controller.ts src/schemas.ts src/__tests__/playStudio.test.ts
git commit -m "$(printf 'feat(play): POST /api/play/studio — seed a miniapp from a source\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Thread a validated miniapp cwd + studio brief through the chat session

**Files:**
- Modify: `src/goldmine/chatRoutes.ts` (`ChatRouteDeps` + `POST /api/chat`), `src/index.ts` (deps + connect wrapper)
- Test: `src/__tests__/chatStudio.test.ts`

**Interfaces:**
- Consumes: `miniappDir`/`studioBrief`/`studioCwd` (`@agentgem/play`), `ChatManager.openChat` cwd/brief params.
- Produces: `ChatRouteDeps` gains `resolveStudio?: (miniapp: string) => { cwd: string; brief: string }`; `POST /api/chat` accepts an optional `miniapp` (string) and, when present, opens the session with that cwd + studio brief. `index.ts` wraps `open()` with `studioCwd(cwd, chatCwd)` instead of forcing `chatCwd`.

- [ ] **Step 1: Write the failing test** — test the route's resolution logic with a fake manager that captures the `openChat` args:

```ts
// src/__tests__/chatStudio.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { registerChatRoutes } from "../goldmine/chatRoutes.js";
import { seedStudio, defaultReaders, miniappDir, studioBrief, miniappsRoot } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

// helper: perform one POST to the express app without a network listener
async function post(app: express.Express, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return await new Promise((resolve) => {
    const req: express.Request = { method: "POST", url: path, headers: {}, body } as never;
    const res = { statusCode: 200, _json: undefined as unknown,
      status(c: number) { this.statusCode = c; return this; },
      json(v: unknown) { this._json = v; resolve({ status: this.statusCode, json: v }); return this; } } as never;
    (app as unknown as { handle: (r: unknown, s: unknown, n: () => void) => void }).handle(req, res, () => resolve({ status: 404, json: undefined }));
  });
}

describe("chat studio wiring", () => {
  it("POST /api/chat with a miniapp opens the session in the miniapp cwd + studio brief", async () => {
    // seed a miniapp so its dir + meta exist
    const seeded = await seedStudio({ kind: "skill", skillName: "brainstorming" }, {
      ...defaultReaders,
      readSkill: async (name) => ({ name, content: "# " + name }),
    });
    let captured: { cwd?: string; brief?: string } | undefined;
    const app = express(); app.use(express.json());
    registerChatRoutes(app as never, {
      manager: { openChat: async (i: { cwd?: string; brief?: string }) => { captured = i; return "chat-1"; } } as never,
      listAgents: () => [],
      buildBrief: async () => "neutral brief",
      goldmineMcp: () => [],
      resolveStudio: (miniapp) => ({ cwd: miniappDir(miniapp), brief: studioBrief(miniapp) }),
    });
    const r = await post(app, "/api/chat", { agentId: "claude", miniapp: seeded.name });
    expect(r.json).toEqual({ chatId: "chat-1" });
    expect(captured?.cwd).toBe(join(miniappsRoot(), seeded.name));
    expect(captured?.brief).toContain(`${seeded.name}.html`);
  });

  it("POST /api/chat without a miniapp uses the neutral brief (no cwd)", async () => {
    let captured: { cwd?: string } | undefined;
    const app = express(); app.use(express.json());
    registerChatRoutes(app as never, {
      manager: { openChat: async (i: { cwd?: string }) => { captured = i; return "chat-2"; } } as never,
      listAgents: () => [], buildBrief: async () => "neutral brief", goldmineMcp: () => [],
      resolveStudio: (m) => ({ cwd: miniappDir(m), brief: studioBrief(m) }),
    });
    await post(app, "/api/chat", { agentId: "claude" });
    expect(captured?.cwd).toBeUndefined();
  });
});
```

> If driving Express via `app.handle` proves flaky in this harness, extract the POST body → openChat-args mapping into a small exported pure function (`studioChatArgs(body, deps)`) in `chatRoutes.ts` and unit-test THAT instead; keep the route handler a thin caller. Either way the test must assert: with `miniapp`, the cwd is the validated miniapp dir and the brief is the studio brief; without it, cwd is undefined.

- [ ] **Step 2: Run test to verify it fails** — `pnpm test -- chatStudio` → FAIL (route ignores `miniapp`).

- [ ] **Step 3: Implement the route + deps change** — in `src/goldmine/chatRoutes.ts`:

Add to `ChatRouteDeps`:
```ts
  resolveStudio?: (miniapp: string) => { cwd: string; brief: string };
```
Replace the `POST /api/chat` handler body (keep the try/catch shape) so it honors an optional `miniapp`:
```ts
const agentId = String(req.body?.agentId ?? "");
if (!agentId) { res.status(400).json({ error: "agentId required" }); return; }
const miniapp = req.body?.miniapp ? String(req.body.miniapp) : "";
let brief: string;
let cwd: string | undefined;
if (miniapp) {
  if (!deps.resolveStudio) { res.status(400).json({ error: "studio not available" }); return; }
  const s = deps.resolveStudio(miniapp);   // miniappDir throws on a bad name → caught below → 500/400
  cwd = s.cwd; brief = s.brief;
} else {
  brief = await deps.buildBrief();
}
const chatId = await deps.manager.openChat({ agentId, brief, mcpServers: deps.goldmineMcp(), ...(cwd ? { cwd } : {}) });
res.json({ chatId });
```

In `src/index.ts`:
- Change the connect wrapper (`:315-316`) from forcing `chatCwd` to honoring a validated cwd:
  ```ts
  open: (cwd: string, opts?: { mcpServers?: unknown[] }) => conn.ctx.open(studioCwd(cwd, chatCwd), opts),
  ```
  (import `studioCwd` from `@agentgem/play`).
- Add the `resolveStudio` dep to the `registerChatRoutes({...})` call:
  ```ts
  resolveStudio: (miniapp: string) => ({ cwd: miniappDir(miniapp), brief: studioBrief(miniapp) }),
  ```
  (import `miniappDir`, `studioBrief` from `@agentgem/play`).

Note: `ChatManager.openChat` passes `cwd` to `conn.ctx.open(cwd)`; the wrapper's `studioCwd` guard means only a path under `miniappsRoot()` is honored, so even if a future caller passed a raw cwd it could not escape — the route's `miniappDir` validation is the first gate, this is the second.

- [ ] **Step 4: Run test to verify it passes** — `pnpm test -- chatStudio` → PASS. Then `pnpm test` (full — chatRoutes + index wiring changed).

- [ ] **Step 5: Commit**
```bash
git add src/goldmine/chatRoutes.ts src/index.ts src/__tests__/chatStudio.test.ts
git commit -m "$(printf 'feat(play): chat studio — POST /api/chat honors a validated miniapp cwd + studio brief\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Full-suite green + wiring smoke

- [ ] **Step 1: Full build + suite** — `pnpm test`. PASS across the suite; only acceptable failure is the pre-existing `consoleMount`. Pay special attention: the chat-session tests (`packages/run` `chatSession` / `chatRoutes` existing tests) must still pass — the cwd wrapper change and the new optional `miniapp` field must not regress the neutral chat path.
- [ ] **Step 2: Confirm wiring** — `grep -n "resolveStudio\|studioCwd\|/api/play/studio" src/index.ts src/goldmine/chatRoutes.ts src/play.controller.ts` → all present.
- [ ] **Step 3: Commit any fixes**
```bash
git add -A && git commit -m "$(printf 'test(play): full suite green with the chat studio wired\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Not this plan

- **Plan 3 — Play console surface:** the Chat panel's studio mode (pass `miniapp` in `POST /api/chat`, render the live sealed-iframe preview of `<name>.html` via `Watch/sandboxDoc.ts`, a "save/commit" button calling `POST /api/play/save`), plus Composer (source→genre→`POST /api/play/studio`→open studio), Arcade (grid over `GET /api/play/miniapps`), and the permission chips + consent + brokers.

## Self-Review

- **Spec coverage (this plan):** per-miniapp validated cwd + seed brief threaded through `POST /api/chat` → `ChatManager.openChat` → a relaxed connect wrapper (T1 `studioCwd` + T3 wiring) ✓; source-seeded studio (T1 `seedStudio` + T2 `POST /api/play/studio`) ✓; the security invariant preserved by two gates (`miniappDir` in the route + `studioCwd` in the wrapper) ✓; full-suite gate (T4) ✓. Console studio UI + live preview are Plan 3.
- **Placeholder scan:** T1 carries a `grep`-and-confirm for `loadSessionTranscript`/`introspectAll`/`suggestTestbed` exports and `introspectAll`'s skills field; T2/T3 note the Express-driving fallback (extract a pure `studioChatArgs`) if `app.handle` is flaky. Both are required actions with concrete fallbacks, not vague TBDs.
- **Type consistency:** `seedStudio`/`studioBrief`/`studioCwd`/`defaultReaders` names consistent across T1-T3 and `index.ts` exports; `resolveStudio` shape `{ cwd; brief }` matches its use in the route and the `index.ts` wiring; `openChat` cwd/brief params match the verified signature.
- **Security:** two independent gates on the request-derived cwd (`miniappDir` rejects bad names; `studioCwd` allow-lists `miniappsRoot()`); the neutral chat path is unchanged when `miniapp` is absent (no cwd passed → wrapper falls back to `chatCwd`).

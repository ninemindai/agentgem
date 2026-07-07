# Miniapp Auto-Checkpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-persist ACP-authored miniapps on every completed chat turn — an ungated git commit for durability, plus an opportunistic marketplace-gem refresh when the bundle is sealed — without changing the explicit Save semantics.

**Architecture:** A new `checkpointMiniapp(name)` in `packages/play` commits the on-disk miniapp (ungated) then, only if `gameGate` passes, UPSERTs the `game` gem. Registry commits are serialized through an in-process per-repo mutex (`commitWithLock`) to avoid `.git/index.lock` races. The trigger lives in the app layer: `chatRoutes.ts` records `chatId → miniapp` at `/api/chat` open time and calls `checkpointMiniapp` after each successful `/api/chat/stream` turn. `@agentgem/run` (`ChatManager`) is untouched.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥24, vitest, supertest, `@agentback/rest`, `child_process` git wrapper, jsdom (inside `gameGate`).

## Global Constraints

- **Node floor:** `>=24`. Do not use APIs unavailable there.
- **Package tests live at repo root** under `src/play/__tests__/` (for `packages/play`) and `src/goldmine/__tests__/` (for the app layer) — NOT inside the package dir. Vitest runs the compiled `dist/`, so **rebuild before running tests** if the runner uses `dist`.
- **Run the FULL play test suite**, never a single isolated file — `src/play/__tests__/*` has cross-file assumptions and isolated runs give false greens.
- **Test isolation:** set `process.env.AGENTGEM_HOME = mkdtempSync(...)` in `beforeEach`, delete it + `rmSync` the dir in `afterEach`. `miniappsRoot()`/`workspaceDir()` derive from `AGENTGEM_HOME`.
- **`safePathSegment` SANITIZES, never throws** — `miniappDir`/`readMiniapp` do the throwing on bad names. Rely on them.
- **Git identity for commits in this repo:** Raymond Feng `<raymond@ninemind.ai>`. End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **UPSERT invariant:** the gem write only ever creates/overwrites; it never deletes. A broken turn skips the gem write and leaves the last sealed gem intact.

---

### Task 1: Serialize registry commits with an in-process mutex

`miniappsRoot()` is a single git repo; `git add -A` + `git commit` touch `.git/index.lock`. Per-turn checkpointing makes concurrent commits routine, so serialize them per-repo.

**Files:**
- Modify: `packages/play/src/git.ts` (add `commitWithLock`, keep `commitAll` as the primitive)
- Modify: `packages/play/src/miniapps.ts` (route `saveMiniapp`'s commit through `commitWithLock`)
- Modify: `packages/play/src/studio.ts` (route `seedStudio`/`importStudio` commits through `commitWithLock`)
- Test: `src/play/__tests__/gitLock.test.ts`

**Interfaces:**
- Produces: `commitWithLock(dir: string, message: string): Promise<string | null>` — same return contract as `commitAll` (commit hash, or `null` when nothing changed), but serialized per `dir`.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/gitLock.test.ts`:

```typescript
// src/play/__tests__/gitLock.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepo, commitWithLock } from "@agentgem/play";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gitlock-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("commitWithLock", () => {
  it("serializes concurrent commits on one repo without an index.lock throw", async () => {
    await ensureRepo(dir);
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    // Fire two commits at the same time. Serialized, both settle without throwing;
    // the first commits the tree (hash), the second finds nothing to commit (null).
    const [r1, r2] = await Promise.all([
      commitWithLock(dir, "one"),
      commitWithLock(dir, "two"),
    ]);
    const hashes = [r1, r2].filter((h): h is string => typeof h === "string");
    expect(hashes.length).toBeGreaterThanOrEqual(1);
    hashes.forEach((h) => expect(h).toMatch(/^[0-9a-f]{7,40}$/));
  });

  it("a failing commit does not wedge the chain for later commits on the same dir", async () => {
    // Never ran ensureRepo on a fresh subdir → first call rejects (not a git repo);
    // the lock must still let a subsequent, valid commit proceed.
    const bad = join(dir, "nope");
    await expect(commitWithLock(bad, "x")).rejects.toBeTruthy();
    await ensureRepo(dir);
    writeFileSync(join(dir, "c.txt"), "c");
    await expect(commitWithLock(dir, "y")).resolves.toMatch(/^[0-9a-f]{7,40}$/);
  });
});
```

Note: `ensureRepo` is already exported from `@agentgem/play` (used by `miniapps.ts`); if the barrel `packages/play/src/index.ts` does not re-export it, add it in Step 3.

- [ ] **Step 2: Run test to verify it fails**

Rebuild then run (barrel lacks `commitWithLock`):

```bash
pnpm --filter @agentgem/play build && pnpm vitest run src/play/__tests__/gitLock.test.ts
```

Expected: FAIL — `commitWithLock is not a function` / import error.

- [ ] **Step 3: Implement `commitWithLock` and export it**

In `packages/play/src/git.ts`, append after `commitAll`:

```typescript
// Serialize commits per-repo: `git add -A` + `git commit` write .git/index.lock, so two concurrent
// commitAll() calls on the SAME repo can collide (one fails on a locked index). Chain commits per dir
// with an in-process promise queue. One server process owns the registry, so in-process is sufficient.
const commitChains = new Map<string, Promise<unknown>>();
export function commitWithLock(dir: string, message: string): Promise<string | null> {
  const prev = commitChains.get(dir) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => commitAll(dir, message));
  // Store a swallowed tail so one rejection never wedges the chain for later commits.
  commitChains.set(dir, next.catch(() => {}));
  return next;
}
```

In `packages/play/src/index.ts`, add `commitWithLock` (and `ensureRepo` if not already present) to the git re-export line, e.g.:

```typescript
export { ensureRepo, commitAll, commitWithLock, setRemote, push } from "./git.js";
```

(Match the existing export style in that file — extend the current git export rather than duplicating it.)

- [ ] **Step 4: Route the existing registry commits through the lock**

In `packages/play/src/miniapps.ts`, change the import from `./git.js` to include `commitWithLock` and replace the `saveMiniapp` commit call:

```typescript
// was: import { ensureRepo, commitAll } from "./git.js";
import { ensureRepo, commitWithLock } from "./git.js";
```
```typescript
// inside saveMiniapp, was: const commit = await commitAll(root, `save miniapp ${safe}`);
const commit = await commitWithLock(root, `save miniapp ${safe}`);
```

In `packages/play/src/studio.ts`, change the import and both commit calls:

```typescript
// was: import { ensureRepo, commitAll } from "./git.js";
import { ensureRepo, commitWithLock } from "./git.js";
```
```typescript
// seedStudio, was: await commitAll(miniappsRoot(), `seed miniapp ${name}`);
await commitWithLock(miniappsRoot(), `seed miniapp ${name}`);
```
```typescript
// importStudio, was: await commitAll(miniappsRoot(), `import miniapp ${name}`);
await commitWithLock(miniappsRoot(), `import miniapp ${name}`);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @agentgem/play build && pnpm vitest run src/play/__tests__
```

Expected: PASS — `gitLock.test.ts` green AND the existing `miniapps.test.ts`/`studio.test.ts`/`readMiniapp.test.ts` still green (commit paths unchanged in behavior, only serialized).

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/git.ts packages/play/src/index.ts packages/play/src/miniapps.ts packages/play/src/studio.ts src/play/__tests__/gitLock.test.ts
git commit -m "feat(play): serialize registry commits with a per-repo mutex

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `checkpointMiniapp` — ungated commit + opportunistic gem

Extract the gem-write into a shared helper, then add the lenient checkpoint alongside the strict `saveMiniapp`.

**Files:**
- Modify: `packages/play/src/miniapps.ts` (add `writeGameGem`, refactor `saveMiniapp`, add `checkpointMiniapp`)
- Modify: `packages/play/src/index.ts` (export `checkpointMiniapp`)
- Test: `src/play/__tests__/checkpoint.test.ts`

**Interfaces:**
- Consumes: `commitWithLock` (Task 1), `readMiniapp`, `gameGate`, `ensureRepo`, `miniappsRoot`.
- Produces: `checkpointMiniapp(name: string): Promise<{ name: string; commit: string | null }>` — ungated commit; writes the `game` gem only when `gameGate(html).ok`; never throws on a gate/gem failure.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/checkpoint.test.ts`:

```typescript
// src/play/__tests__/checkpoint.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointMiniapp, miniappDir } from "@agentgem/play";
import { workspaceDir } from "@agentgem/base";
import { readGemArchive, readArchiveDir } from "@agentgem/archive";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "My Game", genre: "project-fun" as const, createdFrom: { kind: "project" as const, path: "/p", flavor: "node" }, engineVersion: "1" };
const sealed = "<!doctype html><body><canvas></canvas><script>const x=1;</script></body>";
const broken = `<!doctype html><body><canvas></canvas><script>fetch("http://x/")</script></body>`; // fails the gate (network call)

// Write a miniapp draft directly on disk (like seed/import do, but explicit + gate-agnostic).
function draft(name: string, html: string) {
  const dir = miniappDir(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.html`), html);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
}

describe("checkpointMiniapp", () => {
  it("commits an ungated broken draft WITHOUT writing a gem", async () => {
    draft("brk", broken);
    const r = await checkpointMiniapp("brk");
    expect(r.commit).toMatch(/^[0-9a-f]{7,40}$/);              // durability: committed
    expect(existsSync(join(workspaceDir("brk"), "gem.json"))).toBe(false); // no gem for an unsealed draft
  });

  it("commits AND writes the gem for a sealed draft", async () => {
    draft("ok", sealed);
    await checkpointMiniapp("ok");
    expect(existsSync(join(workspaceDir("ok"), "gem.json"))).toBe(true);
  });

  it("leaves a previously-sealed gem intact when a later turn breaks the file (upsert never deletes)", async () => {
    draft("keep", sealed.replace("canvas", "canvas data-v1"));
    await checkpointMiniapp("keep");                            // seals → gem written (v1)
    writeFileSync(join(miniappDir("keep"), "keep.html"), broken); // agent breaks it mid-build
    const r = await checkpointMiniapp("keep");                  // must NOT throw, must still commit
    expect(r.commit).toMatch(/^[0-9a-f]{7,40}$/);
    const art = readGemArchive(readArchiveDir(workspaceDir("keep"))).artifacts[0] as { html: string };
    expect(art.html).toContain("data-v1");                     // gem still holds the last sealed build
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @agentgem/play build && pnpm vitest run src/play/__tests__/checkpoint.test.ts
```

Expected: FAIL — `checkpointMiniapp is not a function` / import error.

- [ ] **Step 3: Extract `writeGameGem` and refactor `saveMiniapp`**

In `packages/play/src/miniapps.ts`, add the helper above `saveMiniapp`:

```typescript
// Write (create-or-overwrite) the marketplace game-gem for a miniapp. Shared by saveMiniapp (strict,
// after a throwing gate) and checkpointMiniapp (opportunistic, only when sealed). UPSERT: overwrites in
// place, never deletes — so a re-save/re-checkpoint stays in sync, and a skipped write keeps the prior gem.
function writeGameGem(name: string, html: string, meta: MiniappMeta): void {
  const artifact: GameArtifact = {
    type: "game", name, title: meta.title, genre: meta.genre,
    html, createdFrom: meta.createdFrom, engineVersion: meta.engineVersion,
    ...(meta.needs ? { needs: meta.needs } : {}),
  };
  const gem: Gem = { name, createdFrom: "play", artifacts: [artifact], checks: [], requiredSecrets: [] };
  const wdir = workspaceDir(name);
  mkdirSync(wdir, { recursive: true });
  writeArchiveDir(wdir, writeGemArchive(gem).files);
}
```

Replace the tail of `saveMiniapp` (the inline artifact/gem block after the commit) with a call to the helper, so the function body becomes:

```typescript
export async function saveMiniapp(input: SaveMiniappInput): Promise<{ name: string; commit: string | null }> {
  const dir = miniappDir(input.name);             // validates the name (throws on bad) + jails the path
  const safe = input.name;
  const gate = await gameGate(input.html);
  if (!gate.ok) throw new Error(`miniapp failed the gate: ${gate.failures.join("; ")}`);
  const root = miniappsRoot();
  await ensureRepo(root);                          // the registry is a git repo
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${safe}.html`), input.html);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(input.meta, null, 2));
  const commit = await commitWithLock(root, `save miniapp ${safe}`);
  writeGameGem(safe, input.html, input.meta);      // strict path: gate already passed above
  return { name: safe, commit };
}
```

- [ ] **Step 4: Add `checkpointMiniapp`**

In `packages/play/src/miniapps.ts`, add after `saveMiniapp`:

```typescript
// Auto-checkpoint: persist the CURRENT on-disk miniapp WITHOUT gating (durability for in-progress agent
// work), then opportunistically refresh the marketplace gem IFF the bundle is sealed. A gate failure never
// blocks the commit and is never thrown — the gem simply isn't rewritten, preserving the last sealed build.
export async function checkpointMiniapp(name: string): Promise<{ name: string; commit: string | null }> {
  const { html, meta } = readMiniapp(name);        // validates the name + jails; meta.json exists post seed/import
  const root = miniappsRoot();
  await ensureRepo(root);
  const commit = await commitWithLock(root, `checkpoint ${name}`);
  try { if ((await gameGate(html)).ok) writeGameGem(name, html, meta); }
  catch { /* gate/gem is best-effort — a checkpoint must never fail on it */ }
  return { name, commit };
}
```

In `packages/play/src/index.ts`, add `checkpointMiniapp` to the miniapps re-export line (next to `saveMiniapp`):

```typescript
export { miniappsRoot, miniappDir, saveMiniapp, checkpointMiniapp, readMiniapp, listMiniapps, type MiniappMeta, type SaveMiniappInput } from "./miniapps.js";
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @agentgem/play build && pnpm vitest run src/play/__tests__
```

Expected: PASS — `checkpoint.test.ts` green AND `miniapps.test.ts` still green (refactor preserved `saveMiniapp` behavior).

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/miniapps.ts packages/play/src/index.ts src/play/__tests__/checkpoint.test.ts
git commit -m "feat(play): checkpointMiniapp — ungated commit + opportunistic gem

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Fire the checkpoint after each successful studio turn

Wire the trigger into the chat routes: remember which chat edits which miniapp, and checkpoint after a non-failed stream.

**Files:**
- Modify: `src/goldmine/chatRoutes.ts` (add `checkpointMiniapp` to `ChatRouteDeps`, a `chatId → miniapp` map, the post-stream call, and map cleanup on DELETE)
- Modify: `src/index.ts` (inject `checkpointMiniapp` into the `registerChatRoutes` deps)
- Test: `src/goldmine/__tests__/chatRoutes.test.ts` (extend)

**Interfaces:**
- Consumes: `checkpointMiniapp(name: string): Promise<{ name: string; commit: string | null }>` (Task 2), injected via `ChatRouteDeps.checkpointMiniapp`.
- Produces: no new exported symbols; behavior — a successful `/api/chat/stream` turn for a miniapp-bound chat invokes `deps.checkpointMiniapp(name)`.

- [ ] **Step 1: Write the failing tests**

In `src/goldmine/__tests__/chatRoutes.test.ts`, extend the fake-connect helper to allow a failing prompt, thread a `checkpointMiniapp` spy + `resolveStudio` into the app fixture, and add three tests. Replace the existing `makeFakeConnectFn` and `buildTestApp` with these parameterized versions, and keep the existing tests working (they call `buildTestApp()` with no args):

```typescript
function makeFakeConnectFn(opts: { fail?: boolean } = {}): ChatConnectFn {
  return async () => ({
    ctx: {
      open: async () => ({
        setMode: async () => {},
        prompt: async (_text: string, onDelta?: (c: string) => void) => {
          if (opts.fail) throw new Error("boom");
          onDelta?.("hi there");
          return { text: "hi there", toolCalls: [] };
        },
        dispose: () => {},
      }),
    },
    close: () => {},
  });
}

async function buildTestApp(opts: { fail?: boolean; checkpoints?: string[] } = {}) {
  const restApp = new RestApplication({});
  restApp.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1", bodyParser: { json: {} } });
  await restApp.start();
  stoppable.push(restApp);

  const server = await restApp.restServer;
  const fakeManager = new ChatManager({ connectFn: makeFakeConnectFn({ fail: opts.fail }) });
  registerChatRoutes(server.expressApp as never, {
    manager: fakeManager,
    buildBrief: async () => "BRIEF",
    goldmineMcp: () => [],
    listAgents: () => [{ id: "claude-code", name: "Claude Code", available: true }],
    resolveStudio: () => ({ cwd: "/tmp/miniapp", brief: "STUDIO" }),
    checkpointMiniapp: async (name: string) => { opts.checkpoints?.push(name); },
  });
  return server.expressApp;
}
```

Add these tests inside `describe("chat routes", ...)`:

```typescript
it("checkpoints after a successful studio (miniapp) turn", async () => {
  const checkpoints: string[] = [];
  const app = await buildTestApp({ checkpoints });
  const created = await request(app).post("/api/chat")
    .set("Content-Type", "application/json")
    .send(JSON.stringify({ agentId: "claude-code", miniapp: "space-run" }));
  const chatId = created.body.chatId;
  await request(app).get(`/api/chat/stream?chatId=${chatId}&message=hi`);
  expect(checkpoints).toEqual(["space-run"]);
});

it("does NOT checkpoint a neutral (non-miniapp) chat", async () => {
  const checkpoints: string[] = [];
  const app = await buildTestApp({ checkpoints });
  const created = await request(app).post("/api/chat")
    .set("Content-Type", "application/json")
    .send(JSON.stringify({ agentId: "claude-code" }));
  await request(app).get(`/api/chat/stream?chatId=${created.body.chatId}&message=hi`);
  expect(checkpoints).toEqual([]);
});

it("does NOT checkpoint when the turn fails", async () => {
  const checkpoints: string[] = [];
  const app = await buildTestApp({ fail: true, checkpoints });
  const created = await request(app).post("/api/chat")
    .set("Content-Type", "application/json")
    .send(JSON.stringify({ agentId: "claude-code", miniapp: "space-run" }));
  const res = await request(app).get(`/api/chat/stream?chatId=${created.body.chatId}&message=hi`);
  expect(res.text).toContain("event: failed");
  expect(checkpoints).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run src/goldmine/__tests__/chatRoutes.test.ts
```

Expected: FAIL — `checkpoints` stays empty (no trigger wired); the neutral/fail tests may already pass but the success test fails. TypeScript may also flag `checkpointMiniapp` as an unknown dep property until Step 3.

- [ ] **Step 3: Add the dep, the map, the trigger, and cleanup**

In `src/goldmine/chatRoutes.ts`, add to the `ChatRouteDeps` interface:

```typescript
  // Studio auto-checkpoint: commit the miniapp's on-disk state after a successful turn (durability).
  // Injected so the route stays testable without the real registry. Absent → checkpointing is a no-op.
  checkpointMiniapp?: (name: string) => Promise<unknown>;
```

At the top of `registerChatRoutes`, before the route registrations, add the map:

```typescript
  // chatId → miniapp name, for studio sessions only. Lets the turn-end handler know which miniapp to
  // checkpoint. Populated on open, cleared on close. A leaked short string is harmless; we tidy anyway.
  const chatMiniapps = new Map<string, string>();
```

In the `POST /api/chat` handler, after `const chatId = await deps.manager.openChat(args);` and before `res.json({ chatId });`, record the binding:

```typescript
      const miniapp = req.body?.miniapp ? String(req.body.miniapp) : "";
      if (miniapp) chatMiniapps.set(chatId, miniapp);
```

In the `GET /api/chat/stream` handler, track failure inside the loop and checkpoint after it. Replace the `try { for await ... } catch ...` block with:

```typescript
    let failed = false;
    try {
      for await (const ev of deps.manager.sendMessage(chatId, message)) {
        if (ev.type === "failed") failed = true;
        send(ev.type, ev);
      }
    } catch (e) {
      failed = true;
      send("failed", { error: (e as Error).message });
    }

    // Turn done. For a studio session that did NOT fail, checkpoint the miniapp (durability + opportunistic
    // gem). The client already received `done`; this runs after and never affects the turn — a checkpoint
    // failure is logged and swallowed.
    const miniapp = chatMiniapps.get(chatId);
    if (!failed && miniapp && deps.checkpointMiniapp) {
      try { await deps.checkpointMiniapp(miniapp); }
      catch (e) { console.error(`checkpoint failed for miniapp ${miniapp}:`, (e as Error).message); }
    }

    res.end();
```

(Remove the old `res.end();` that followed the original try/catch so it isn't duplicated.)

In the `DELETE /api/chat/:chatId` handler, clear the map entry:

```typescript
  app.delete("/api/chat/:chatId", guard, (req, res) => {
    deps.manager.closeChat(req.params.chatId);
    chatMiniapps.delete(req.params.chatId);
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Inject the real `checkpointMiniapp` in `src/index.ts`**

In `src/index.ts`, add `checkpointMiniapp` to the existing `@agentgem/play` import (line ~40, currently `import { studioCwd, miniappDir, studioBrief } from "@agentgem/play";`):

```typescript
import { studioCwd, miniappDir, studioBrief, checkpointMiniapp } from "@agentgem/play";
```

In the `registerChatRoutes(server.expressApp as never, { ... })` deps object (line ~330), add:

```typescript
      checkpointMiniapp: (name: string) => checkpointMiniapp(name),
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @agentgem/play build && pnpm vitest run src/goldmine/__tests__/chatRoutes.test.ts
```

Expected: PASS — all three new tests green, plus the four pre-existing chat-route tests still green.

- [ ] **Step 6: Typecheck the app + commit**

```bash
pnpm -w build
git add src/goldmine/chatRoutes.ts src/index.ts src/goldmine/__tests__/chatRoutes.test.ts
git commit -m "feat(goldmine): auto-checkpoint miniapp after each successful studio turn

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Full-suite regression + finish

**Files:** none (verification only)

- [ ] **Step 1: Rebuild and run the full test suite**

```bash
pnpm -w build && pnpm -w test
```

Expected: PASS across the repo. If the root suite excludes `packages/console` (it does — console tests are not in CI), that's expected; do not chase console failures unrelated to this change.

- [ ] **Step 2: Verify the branch is ahead of origin/main only**

```bash
git fetch origin && git log --oneline origin/main..HEAD
```

Expected: exactly the three feature commits (Tasks 1–3) plus the design/plan doc commits, all atop `origin/main` — nothing from an unrelated stream.

- [ ] **Step 3: Open the PR (default integration path)**

```bash
git push -u origin feat/miniapp-auto-checkpoint
gh pr create --fill --base main
```

Then gate on CI per the repo's PR lifecycle (`gh run watch <run-id> --exit-status`, then `gh pr merge --rebase --delete-branch`). After merge, `git fetch` and confirm a marker from EACH commit is on `origin/main` (the dropped-commit trap has bitten multi-commit PRs here before).

---

## Self-Review

**1. Spec coverage:**
- Server-side turn-end trigger → Task 3. ✓
- `checkpointMiniapp` commit + opportunistic gem → Task 2. ✓
- Shared `writeGameGem` extraction / strict-vs-lenient split → Task 2. ✓
- Commit serialization mutex → Task 1. ✓
- `@agentgem/run` untouched → confirmed; all changes in `packages/play` + app layer. ✓
- Manual Save unchanged → no task touches `Studio.tsx` (kept as-is). ✓
- Invariant (gem = last sealed build; UPSERT never deletes) → Task 2 test 3. ✓
- Known gaps (disconnect, commit volume) → intentionally no task; documented in spec. ✓
- Testing plan (checkpoint units, trigger units, concurrency) → Tasks 1–3 tests. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every run step shows the command + expected result. ✓

**3. Type consistency:** `checkpointMiniapp(name: string): Promise<{ name: string; commit: string | null }>` is defined identically in Task 2 (impl + export) and consumed in Task 3 (dep type `(name: string) => Promise<unknown>`, which the concrete return satisfies). `commitWithLock(dir, message): Promise<string | null>` matches `commitAll`'s contract and its call sites in Tasks 1–2. `writeGameGem(name, html, meta)` signature is consistent between `saveMiniapp` and `checkpointMiniapp`. ✓

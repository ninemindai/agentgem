# Miniapp auto-checkpoint (server-side, turn-end)

**Status:** design approved · **Date:** 2026-07-07 · **Branch:** `feat/miniapp-auto-checkpoint`

## Problem

Miniapps in the Play studio are built by chatting with an ACP agent, which edits
`<name>.html` directly on disk in the git-backed registry (`~/.agentgem/miniapps/`).
Those edits sit in the **uncommitted working tree** until a human clicks **Save**.
`saveMiniapp` is the only thing that commits — and it fuses three responsibilities:
a git commit, the `gameGate` seal check (a hard `throw`), and the marketplace
`game`-gem UPSERT.

Because the author is an ACP agent, not a human hand-timing Save, a closed or
crashed session loses everything since the last `seed`/`import` commit. The gate,
meanwhile, makes it impossible to auto-fire `saveMiniapp` per turn: mid-build the
file is routinely invalid (half-written JS, unclosed tags), so the gate would throw
on nearly every intermediate state.

## Goal

Persist agent work automatically, without coupling durability to the seal check or
polluting the marketplace with half-built drafts. Keep the existing explicit Save
semantics intact.

## Key decisions (settled during brainstorming)

1. **Trigger: server-side, turn-end.** Checkpoint on the backend when each ACP
   turn's stream finishes, not from the Studio UI's `onDone`. This covers the
   Studio tab *and* any headless/programmatic ACP session; it doesn't depend on a
   browser being open.
2. **Checkpoint scope: commit + opportunistic gem.** Auto-checkpoint always does an
   **ungated** git commit (so a broken draft still persists). It *also* runs the
   gate silently — if the file is sealed, it UPSERTs the `game` gem; if not, it
   just leaves the commit. The gem is never blocked by a mid-build failure and the
   commit is never blocked by the gate.
3. **Manual Save stays, reframed.** The `Save` button is kept unchanged. Its
   happy-path role is now redundant, but it remains the way to get **actionable
   seal feedback**: the auto gem-sync is silent, so `Save`/`shareToExplore` is what
   surfaces the gate-failure banner when a user wants to publish an unsealed file.
4. **`@agentgem/run` stays miniapp-agnostic.** No changes to `ChatManager`. All
   miniapp knowledge lives in the app layer (`chatRoutes.ts`), which already
   resolves the miniapp name at `/api/chat` open time.

## Invariant

**The `game` gem always reflects the last *sealed* build.** An UPSERT only ever
writes — it never deletes. So a broken turn skips the gem write and leaves the
previously-written gem untouched. The gem never "drifts out of existence"; it holds
the most recent known-good sealed state.

## Architecture & data flow

```
POST /api/chat {miniapp}  ──▶ studioChatArgs ──▶ record chatId→name in a Map
GET  /api/chat/stream     ──▶ for await (…turn…) { send events }   ← "done" already reached client
                              └▶ AFTER loop, on success: name = map.get(chatId)
                                                         → checkpointMiniapp(name)  [try/catch, logged]
```

The `done` event is yielded as the last item of the `sendMessage` generator, so by
the time the `for await` loop exits the client has already received it and the
Studio's `onDone` (refresh) has fired. Running the checkpoint **after** the loop
means checkpoint latency and any checkpoint failure are invisible to the turn — a
failed checkpoint is logged and swallowed, never converting a successful turn into a
failure.

## Components

### `packages/play` — `checkpointMiniapp(name)`

New persistence primitive in `miniapps.ts`:

```
checkpointMiniapp(name):
  { html, meta } = readMiniapp(name)                 // meta.json always exists post-seed/import
  ensureRepo(root)
  await commitWithLock(root, `checkpoint ${name}`)   // ALWAYS, ungated (durability)
  if ((await gameGate(html)).ok:
    writeGameGem(name, html, meta)                    // opportunistic; gate failure is swallowed
  return { name, commit }
```

Extract the inline gem-write block currently in `saveMiniapp`
(`miniapps.ts:50-58`) into a shared helper `writeGameGem(name, html, meta)`, reused
by both:

- `saveMiniapp` — **strict**: `gameGate` throws on failure (unchanged external
  behavior), then `writeGameGem`, then commit.
- `checkpointMiniapp` — **lenient**: commit first, then gate silently gates only the
  gem write.

### `packages/play` — commit serialization (`git.ts`)

`miniappsRoot()` is a **single** git repo; `commitAll` runs `git add -A` →
`git commit`. Two concurrent checkpoints (two Studio tabs, or headless + UI) would
race on `.git/index.lock` and one would fail. This hazard exists today for
double-Saves but per-turn checkpointing makes it routine.

Add a tiny in-process promise-chain mutex keyed by repo root
(`commitWithLock(root, msg)`), serializing commits to the registry. One
`ChatManager` per server process, so an in-process lock is sufficient. Both
`saveMiniapp` and `checkpointMiniapp` (and `seedStudio`/`importStudio` if trivially
convertible) route their commits through it.

### `src/goldmine/chatRoutes.ts` — the trigger

- In the `POST /api/chat` handler, after `openChat`, record `chatId → miniapp`
  (only when `body.miniapp` is set) in a `Map` owned by `registerChatRoutes`.
- In the `GET /api/chat/stream` handler, after the `for await` loop completes
  **without** a `failed` event, look up the miniapp name and call
  `checkpointMiniapp(name)` inside a `try/catch` that logs and swallows.
- Clean the map entry on the existing `DELETE`/close path (a leaked short string is
  harmless, but tidy on close).

`checkpointMiniapp` is injected as a `ChatRouteDeps` dependency (like
`resolveStudio`) so the route stays unit-testable without the real registry.

## Error handling

- Checkpoint failure (git error, gate throw leaking, gem write error): logged,
  swallowed — never surfaced to the turn, which already emitted `done`.
- `gameGate` inside `checkpointMiniapp`: wrapped so a gate *failure* means "skip the
  gem", and a gate *throw* (unexpected) is caught and skips the gem too; the commit
  still stands.
- Concurrent commits: serialized by `commitWithLock`; no `index.lock` contention.

## Known gaps (out of scope for v1)

- **Client mid-stream disconnect** — if the SSE client drops mid-turn, that turn's
  edits may not checkpoint until the *next* turn. Acceptable; a
  checkpoint-on-`closeChat` hook can be added later if it bites.
- **Commit volume** — a long build produces many `checkpoint` commits. Git is cheap
  and the registry is local; squash-on-publish is a later nicety.

## Testing

- `checkpointMiniapp` (unit, `packages/play`):
  - broken draft → commit made, **no** gem written.
  - sealed draft → commit made, gem written.
  - gate-fail after a prior seal → prior gem left intact (UPSERT-never-deletes).
  - reuses the existing jsdom `getContext` stub the gate needs.
- Trigger (unit, extend `studioChatArgs`/stream tests in the app layer):
  - a studio turn fires `checkpointMiniapp` with the right name.
  - a neutral (non-miniapp) chat fires **no** checkpoint.
  - a `failed` turn fires **no** checkpoint.
- Concurrency: two overlapping `checkpointMiniapp` calls both succeed (no
  `index.lock` throw).
- Run the FULL `packages/play` suite (gemTypeRegistry-style hardcoded counts can
  live elsewhere; avoid isolated-file false greens).
```

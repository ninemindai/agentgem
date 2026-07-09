# Task 9 Report: Draft-a-Gem Handoff

## validateSelection behavior

`validateSelection(raw, inv)` in `src/goldmine/draftGem.ts`:
- Accepts `unknown` input; returns `{}` for null, non-object, or array inputs.
- For valid objects, runs each of `skills`, `mcpServers`, `hooks` through a `keep()` filter that checks each proposed name against the corresponding `ConfigInventory` pool.
- Non-array values for a key (e.g. a string instead of `[]`) are treated as empty.
- Only keys with at least one valid name appear in the returned object (no empty arrays).
- Returns plain `Exclude<GemSelection, { all: true }>` — the narrow selection shape `buildGem` accepts directly.

## How draftGemFromChat drives the live turn + parses

`draftGemFromChat(deps, chatId)` in `src/goldmine/draftGem.ts`:
1. Sends a strict single-turn prompt via `deps.manager.sendMessage(chatId, DRAFT_PROMPT)`. The prompt instructs the agent to reply with ONLY `{"skills":[],"mcpServers":[],"hooks":[]}` naming installed artifacts, no prose.
2. Iterates the `AsyncGenerator<ChatEvent>` from `sendMessage`:
   - On a `"failed"` event: returns `{ error: ev.error }` immediately.
   - On a `"done"` event: captures `result.text` and breaks.
3. Extracts the first `{...}` block (first-brace / last-brace slice) from the accumulated text. Returns `{ error: "no JSON block found …" }` if none found.
4. Calls `validateSelection(parsed, inv)` against `introspectConfig()` (from `@agentgem/capture`, lazily imported; overrideable via `deps.introspect` for tests).
5. Computes `dropped` = names the agent proposed across all three arrays that are absent from `selection`.
6. Calls `buildGem(inv, selection)` (from `@agentgem/build`).
7. Returns `{ selection, gem, dropped }`. All errors are caught → `{ error: string }`.

## buildGem call shape

```ts
buildGem(inv: ConfigInventory, selection: GemSelection): Gem
```

Used with the narrow selection (no `opts`); the gem's name defaults to `"gem"` and `createdFrom` to `"unknown"`. The result is returned directly to the client — no draft store persisted.

## Deferred: Curate deep-link

There is no persistent "Curate draft store" in this repo. The route returns the built Gem JSON directly to the client. A future Curate deep-link integration can persist the result via a store once that store exists. This is noted in a code comment in both `draftGem.ts` and `chatRoutes.ts`.

## Test approach + collection proof

File: `src/goldmine/__tests__/draftGem.test.ts`

**validateSelection unit tests (8 tests):**
- keeps known names, drops hallucinated
- returns {} when nothing valid
- ignores malformed input (string)
- ignores null input
- ignores non-object (number)
- filters hooks correctly
- handles empty arrays → {}
- handles non-array skill values gracefully

**draftGemFromChat integration tests (3 tests), using a fake ChatManager seam:**
- Fake `sendMessage` that yields a `delta` then `done` with JSON text containing a hallucinated name ("ghost") → asserts `selection` is validated, `gem.artifacts` contains valid names only, `dropped` contains "ghost".
- Fake `sendMessage` that yields `failed` event → asserts `{ error }` returned with the error message.
- Fake `sendMessage` that yields `done` with no JSON → asserts `{ error }` matching `/no json/i`.

**Run result:** 11 tests, 11 passed, 0 failed.

## Files changed

- `src/goldmine/draftGem.ts` — NEW: `validateSelection` + `draftGemFromChat` + deps seam type
- `src/goldmine/__tests__/draftGem.test.ts` — NEW: 11 tests
- `src/goldmine/chatRoutes.ts` — MODIFIED: added `import { draftGemFromChat }` and `POST /api/chat/:chatId/draft-gem` route

## Self-review

- `validateSelection` is pure and handles all edge cases.
- `draftGemFromChat` never throws (try/catch → `{ error }`); all failure modes covered.
- The route follows the identical duck-typed Express pattern as existing routes.
- `buildGem` throws `InvalidInputError` for names not in inventory, but `validateSelection` pre-filters them so `buildGem` never sees hallucinated names — the catch wraps it anyway.
- `deps.introspect` seam allows tests to inject a fake inventory without touching the real filesystem.
- No new npm dependencies introduced.

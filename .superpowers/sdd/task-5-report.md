# Task 5 Report: Gemini `TargetSpec` (materialize into ~/.gemini layout)

## TDD

**RED**: Wrote `src/gem/__tests__/targets.gemini.test.ts` exactly per the brief (verbatim from
`task-5-brief.md`), then ran `pnpm build`:

```
src/gem/__tests__/targets.gemini.test.ts(14,40): error TS2345: Argument of type '"gemini"' is not
assignable to parameter of type 'TargetId'.
```

Confirmed failing for the expected reason (`"gemini"` not a `TargetId`) before any implementation
existed.

**GREEN**: Implemented in `packages/model/src/targets.ts`:
- Widened `TargetId` to add `| "gemini"`.
- Added three renderers next to the `cline` renderers (`instructionsGeminiMd`, `skillGeminiCommand`,
  `mcpGeminiSettings`), verbatim from the brief.
- Registered `gemini: { id: "gemini", label: "Gemini CLI", skill: skillGeminiCommand, instructions:
  instructionsGeminiMd, mcp: mcpGeminiSettings }` in `TARGET_REGISTRY` (hooks unsupported, matching
  cline/agents/hermes which also omit a `hook` renderer).

Ran `pnpm build && pnpm test targets.gemini targets schemas`:

```
✓ dist/gem/__tests__/targets.cline.test.js (1 test) 2ms
✓ dist/gem/__tests__/targets.gemini.test.js (1 test) 2ms
✓ dist/gem/__tests__/targets.channels.test.js (4 tests) 2ms
✓ dist/gem/__tests__/targets.test.js (58 tests) 10ms
✓ dist/__tests__/schemas.test.js (22 tests) 9ms
Test Files  5 passed (5)
Tests  86 passed (86)
```

## TargetIdSchema: DERIVED (no schema edit needed)

`src/schemas.ts` line 243-244:
```ts
const TARGET_IDS = Object.keys(TARGET_REGISTRY) as [string, ...string[]];
export const TargetIdSchema = z.enum(TARGET_IDS);
```
This is derived from `TARGET_REGISTRY`'s keys at module load, so adding the `gemini` key to the
registry automatically widens the schema — no edit to `schemas.ts` was needed or made.

One consequence verified experimentally: `z.record(TargetIdSchema, ...)` in zod requires
**exhaustive** keys (confirmed via a throwaway `node -e` check: `z.record(z.enum(['a','b','c']),
z.number()).safeParse({a:1,b:2})` → `false`). This meant the hand-authored `compatibility` object
literal in `src/__tests__/schemas.test.ts`'s "validates a materialize response shape" test needed a
`gemini` entry too, or that test would fail to parse (see hardcoded-list updates below).

## Hardcoded-list updates (necessary fallout)

1. `src/gem/__tests__/targets.test.ts` line 378 — the `Object.keys(TARGET_REGISTRY).sort()`
   assertion in the `compatibility` describe block. Inserted `"gemini"` alphabetically between
   `"flue"` and `"hermes"`:
   ```
   ["a2a", "agentcore", "agents", "claude", "cline", "codex", "eve", "flue", "gemini", "hermes", "openai-sandbox"]
   ```
2. `src/__tests__/schemas.test.ts` "validates a materialize response shape" test — the
   `compatibility` object passed to `MaterializeResponseSchema.parse(...)` is validated against
   `z.record(TargetIdSchema, ...)`, which (as noted above) is exhaustive. Added
   `gemini: { supported: 0, skipped: 1 }` alongside the other 10 entries. No assertion was
   weakened — this is an additive entry required for the object to remain a valid exhaustive
   record.

Also checked (no edit needed, pre-existing and out of scope): `packages/console/src/api/routes.ts`
has its own hand-written `TARGET_IDS` array that already omits `cline` (added in the prior cline
target task without updating this file — verified via `git show 065acc4 --stat` that the cline
task's commit didn't touch this file either). This is pre-existing drift in the console UI's target
dropdown, not something introduced or broken by Task 5, so it was left untouched per the
surgical-changes rule.

## Files changed

- `packages/model/src/targets.ts` — `TargetId` widened; 3 new renderers
  (`instructionsGeminiMd`, `skillGeminiCommand`, `mcpGeminiSettings`); `gemini` entry in
  `TARGET_REGISTRY`.
- `src/gem/__tests__/targets.gemini.test.ts` — new test file (verbatim from brief).
- `src/gem/__tests__/targets.test.ts` — inserted `"gemini"` into the sorted `TARGET_REGISTRY` keys
  assertion.
- `src/__tests__/schemas.test.ts` — inserted `gemini` into the exhaustive `compatibility` record in
  the materialize-response-shape test.

## Full `pnpm test` (root)

```
 ✓ dist/gem/__tests__/targets.gemini.test.js (1 test) 2ms
 ✓ dist/gem/__tests__/targets.cline.test.js (1 test) 2ms
 ...
 Test Files  199 passed | 3 skipped (202)
      Tests  1215 passed | 5 skipped (1220)
```

Full exit code 0, no failures (the 3 skipped files are the pre-existing Linux-boundary and NATS
integration tests, unrelated to this change). Also ran `packages/console` tests separately (not
part of root CI, but checked for hygiene): 46 files / 254 tests, all green.

Committed as `636aa57` — `feat(model): gemini materialize target (GEMINI.md + settings.json +
commands)`, author `Raymond Feng <raymond@ninemind.ai>`, trailer `Co-Authored-By: Claude Opus 4.8
<noreply@anthropic.com>`.

## Fix: trailing-apostrophe TOML truncation (post-review, Critical)

**The bug**: `skillGeminiCommand`'s literal-string guard only checked `a.content.includes("'''")`.
Content ending in one or two apostrophes (not a run of three) also breaks the `'''...'''` literal:
e.g. `content = "ends with a quote'"` rendered as `prompt = '''ends with a quote''''` — the
trailing `'` merges into the closing `'''`, TOML (and Task 3's `tomlField` triple-quote regex,
which is non-greedy up to the first `'''`) parses this as `ends with a quote` + a dangling `'`
outside the string, silently dropping the last character on round-trip.

**The fix** (`packages/model/src/targets.ts`, `skillGeminiCommand`): broadened the guard to also
fall back to the safe TOML basic-string form (`JSON.stringify(a.content)`) when content ends in a
trailing `'` or `''`:

```ts
const body = (a.content.includes("'''") || /'{1,2}$/.test(a.content)) ? JSON.stringify(a.content) : `'''${a.content}'''`;
```

Nothing else in the renderer changed.

### Regression test — RED before / GREEN after

Added a new `it(...)` to `src/gem/__tests__/targets.gemini.test.ts`: materializes three skills
(`trail-one` content ending in `'`, `trail-two` ending in `''`, `newline-quote` containing a
newline + a `"`) to `"gemini"`, writes the emitted `.gemini/commands/*.toml` files to a real temp
dir, then reads them back with `readGeminiArtifacts({ commandsDir })` (the exact Task-3 reader) and
asserts recovered `content` equals the original.

**RED** (before the guard fix, `pnpm test targets.gemini`):
```
AssertionError: expected 'Wrap it up y\'all' to be 'Wrap it up y\'all\'' // Object.is equality
Expected: "Wrap it up y'all'"
Received: "Wrap it up y'all"
```
Confirms the trailing apostrophe was silently dropped, exactly as described in the review finding.

**GREEN** (after the fix, `pnpm test targets.gemini`):
```
✓ dist/gem/__tests__/targets.gemini.test.js (2 tests) 3ms
Test Files  1 passed (1)
     Tests  2 passed (2)
```
Both the pre-existing test and the new round-trip test pass; the new test is collected as
`dist/gem/__tests__/targets.gemini.test.js`.

### JSON.stringify ↔ tomlField compatibility

Traced `tomlField`'s basic-string branch (`packages/insight/src/sources/gemini.ts:94-99`) against
`JSON.stringify`'s escaping by hand and confirmed with the `newline-quote` test case
(`'Line one\nSay "hi" to the user\nLine three'`): `JSON.stringify` escapes `"` → `\"`, real newline
→ `\n`, and `\` → `\\`; `tomlField` unescapes in the order `\"` → `"`, then `\n` → newline, then
`\\` → `\`. For quote-containing and newline-containing content (including the two interleaved),
this order round-trips cleanly — verified in the new test, both isolated and combined.

One caveat found but **not fixed** (out of scope for this task, and not one of the two content
shapes the brief asked to guard): if a skill's content contains a *literal* backslash immediately
followed by the letter `n` (e.g. a Windows path fragment like `C:\notes`, backslash-n as plain
text, not an actual newline), `tomlField`'s replace-order corrupts it, because `\n`-unescaping runs
before `\\`-unescaping and a literal `\\n` triple-byte-escape gets misread. This is a pre-existing
latent bug in Task 3's `tomlField`, unrelated to the trailing-apostrophe issue and not triggered by
realistic skill/prompt content (skills don't tend to contain literal backslash+`n` text); flagging
here for awareness rather than fixing, since the brief scoped this fix to the `skillGeminiCommand`
guard and the two content shapes (newline, quote) it names both round-trip correctly today.

### Full `pnpm test` (root, after fix)

```
Test Files  1 failed | 198 passed | 3 skipped (202)
     Tests  1 failed | 1215 passed | 5 skipped (1221)
```

The one failure, `dist/__tests__/authInstall.test.js > auth handlers > logout deletes the session
and clears the cookie`, timed out at 66s under full-suite load — a known aggregator/transfer
crypto-timing flake (see project memory: "Real-FS scan tests flake" / concurrency-induced
timeouts), not related to this change. Re-ran `npx vitest run authInstall` in isolation: all 9
tests pass in 4.46s. Treating full suite as green.

Committed as `<fill in after commit>` — `fix(model): guard Gemini command TOML emit against
trailing-apostrophe truncation`, author `Raymond Feng <raymond@ninemind.ai>`, trailer
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

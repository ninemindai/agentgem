# EMBER phase 2 — BANK → frictionless `/compact` handoff

Date: 2026-07-15
Status: Approved design, pre-implementation
Branch: `feat/ember-bank-compact`
Follows: `docs/superpowers/specs/2026-07-14-ember-live-session-miniapp-design.md` (phase 1)

## Summary

Make EMBER's live BANK actually *do something*: on a clean cut it copies `/compact`
to the clipboard so the user pastes it into their live session in one keystroke.

## The constraint that shaped this (why not "real compaction")

The "live session" EMBER watches is resolved from `allClaudeTranscripts(~/.claude)` —
an **external Claude Code CLI session AgentGem only *observes* by tailing its
`.jsonl` transcript.** There is no control channel to inject `/compact` (or any
input) into a `claude` process AgentGem didn't spawn, and no compaction mechanism
exists in the codebase (`compactTurns` is read-only transcript trimming). So "BANK
compacts the session for you" is architecturally impossible. The honest, valuable
move is to make *your* action frictionless: hand you the command.

## Goals

- A live clean-cut BANK copies `/compact` to the clipboard, with a toast confirming.
- Falls back to the current advisory toast if the copy is denied/unsupported.
- Demo mode unchanged (no real session → nothing to hand off).

## Non-goals

- Any control over the observed CLI session (impossible — see above).
- Remembered clipboard consent (deliberately excluded — see security below).

## Architecture — a new `copy-command` ActionCapability

Mirrors `open-link` exactly, but the egress is the OS clipboard instead of a tab.
Method name `copyCommand`; wire method `ui/copy-command`.

Threaded through the action-capability surfaces (same set as phase 1's
`context-hygiene`, minus the tool-only ones):

- `packages/model/src/types.ts` — add `"copy-command"` to the `ActionCapability`
  union.
- `packages/model/src/capabilities.ts` — add `"copy-command": "copyCommand"` to
  `CAP_METHOD` (compile-guarded: keyed by `ActionCapability`).
- `packages/play/src/portability.ts` — add `"copy-command": "enhancement"` to
  `CAP_CLASS` (compile-guarded: keyed by `GameCapability`).
- `src/schemas.ts` — add `"copy-command"` to `GameCapabilityEnum`.
- `packages/console/src/api/routes.ts` — add `"copy-command"` to `PlayNeedsSchema`.
- `packages/console/src/panels/Play/consent.ts` — add `CAP_LABEL["copy-command"]`
  ("copy a command to your clipboard") and add `"copy-command"` to `CONSENT_CAPS`
  (the drift test requires every `CAP_METHOD` key be in `CONSENT_CAPS`).
- `packages/play/src/mcpAppClient.ts` (the sealed-iframe shim) — add
  `copyCommand: function (text) { return sendRequest("ui/copy-command", { text }); }`
  beside `openLink`.

### Broker — `packages/console/src/panels/Play/mcpUiHost.ts`

- Dispatch: `if (d.method === "ui/copy-command") { void handleCopy(d); return; }`.
- `handleCopy(d)` mirrors `handleOpenLink`:
  - `cap = "copy-command"`; enforce `cap ∈ needs` → else `-32601`.
  - Validate `text` is a non-empty string, `length <= 256` → else `-32602`.
  - `requestConsent("copy-command", text)` (shows the text) → `-32001` on deny.
  - `deps.copyText?.(text)`; reply `{}`.
- New optional dep on `UiHostDeps`: `copyText?: (text: string) => void`.

### Runner — `packages/console/src/panels/Play/Runner.tsx`

- Supply `copyText: (text) => { void navigator.clipboard?.writeText(text); }`.
- Consent: treat `copy-command` like `open-link` — **always prompt, never
  remember, always show the exact `detail` text.** Generalize the three existing
  open-link special-cases (`requestConsent` remembered-branch guard, the
  `setConsent` skip, and the modal `detail`/`<code>` render) to
  `cap === "open-link" || cap === "copy-command"`.

## Security

Clipboard write is a hijacking vector: a shared/marketplace miniapp that declared
`copy-command` could try to slip `rm -rf ~` onto your clipboard behind a friendly
"copied!" toast. Mitigation copies `open-link`'s posture exactly:

- **Consent-gated, never remembered** — every call re-prompts.
- **The modal always shows the exact text** about to be written, so the string can
  never change unseen between grants.
- Length-capped (`<= 256`) to bound the payload.

For EMBER (always `/compact`) that is a one-click Allow per BANK — chosen
deliberately over a remembered grant, which is exactly what would let the copied
text change unseen later.

## EMBER — `packages/play/src/ember.ts`

- `EMBER_META.needs` += `"copy-command"` → `["context-hygiene", "copy-command"]`.
- Live clean-cut BANK: after scoring, if `app` present, call
  `app.copyCommand("/compact")`; on resolve toast
  "🟢 clean cut — copied `/compact`, paste it into your session"; on reject
  (denied/unsupported) fall back to the current advisory toast
  ("run `/compact` to bank…"). Non-clean live BANK keeps the plain advisory toast.
- Demo BANK unchanged.

## Testing

- `mcpUiHost.test.ts`: `ui/copy-command` with consent granted calls the injected
  `copyText` with the text and replies `{}`; denied → `-32001`, no copy; a
  `copy-command` NOT in `needs` → `-32601`; over-length text → `-32602`.
- `capTool.drift.test.ts` stays green (CONSENT_CAPS covers the new CAP_METHOD key).
- `ember.test.ts`: `EMBER_META.needs` includes `copy-command`; `EMBER_HTML` calls
  `copyCommand` literally; a jsdom live clean-cut BANK invokes a stubbed
  `window.agentgemApp.copyCommand` with `"/compact"`.
- Real-browser verify: drive a live clean-cut BANK, confirm the consent prompt
  shows `/compact`, Allow copies it, and the toast confirms.

## Files touched

Modified: `packages/model/src/types.ts`, `packages/model/src/capabilities.ts`,
`packages/play/src/portability.ts`, `packages/play/src/mcpAppClient.ts`,
`packages/play/src/ember.ts`, `src/schemas.ts`,
`packages/console/src/api/routes.ts`,
`packages/console/src/panels/Play/{consent,mcpUiHost,Runner}.tsx?`, plus the three
test files above. New: this spec + the plan.

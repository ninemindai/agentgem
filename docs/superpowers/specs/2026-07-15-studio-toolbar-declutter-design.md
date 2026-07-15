# Studio publish toolbar declutter — design

**Date:** 2026-07-15
**Status:** approved
**Scope:** `packages/console` — Play Studio head row (`src/panels/Play/Studio.tsx`, `src/shell/theme.css`)

## Problem

The Studio head row holds 8 controls of mixed weight: Save, (Stop), Push to git, a
tags text input, three Public/Unlisted/Private visibility pills, "Share to
app.agentgem.ai", and Request review. Two of them render as red primaries at once
(the selected visibility pill and the Share button), and per-publish *settings*
(tags, visibility) sit alongside always-relevant *actions*. The row is crowded.

## Decision (user-approved)

1. **Move the visibility pills and the tags input out of the toolbar and into the
   share flow** — specifically into the existing cover-confirm banner that every
   share already pauses at ("Use this as the share card cover?").
2. **Rename the Share button to one word: `Share`**, keeping `play-btn--primary`.
   The full destination survives as `title="Share to app.agentgem.ai"`; the
   success banner already reads "Published to app.agentgem.ai".

Toolbar after: `← Arcade · title · genre pill · status · Save · (Stop) · Push to
git · Share · Request review`. No settings in the row.

## Why the cover-confirm banner

The share flow is: `shareToExplore()` → save → screenshot capture → **cover-confirm
banner (always pauses, `coverStage === "confirm"`)** → `proceedToPublish()` →
identity gate → `checkAndPublish()` → optional version-conflict banner →
`publishWorkspace(login, version, scope)`.

- `scope` is read only late (`checkAndPublish` line ~341 and the version-conflict
  banner buttons), and `tags` only inside `publishWorkspace` — both **after** the
  banner resolves. Moving the JSX into the banner therefore requires **no logic or
  flow changes**; the `useState` hooks stay where they are.
- The banner is the moment of sharing, which is the right moment to decide
  per-publish settings. Zero extra clicks versus today.
- Alternative considered and rejected: a dropdown/split Share button (adds a click
  and a new popover component); a full publish modal (biggest redesign, not needed).

## Banner layout

Inside `.play-banner__body`, below the existing title + detail lines, add a
settings row:

```
🖼️ [cover img]  Use this as the share card cover?
                Captured from the preview — swap it for your own image, or skip…
                [tags, comma separated        ]  (Public) (Unlisted) (Private)
                                 [Use this] [Re-capture] [Upload] [Skip]
```

- Reuse the existing `.play-tags-input` and `.play-scope` markup/classes verbatim
  (same `aria-label`s, same `role="radiogroup"`).
- One new CSS rule in `src/shell/theme.css`:
  `.play-banner__opts { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; align-items: center; }`
  Every new className gets a matching CSS rule (project rule).

## Non-goals / unaffected surfaces

- **Request review** never passes through the cover banner and does not consume
  tags or visibility (its modal collects group + description) — nothing is lost.
- The version-conflict banner (`pendingVersion`) still publishes with `scope`; the
  value was chosen in the cover banner one step earlier.
- Default visibility stays `"public"`.
- No server/API changes; no marketplace changes.

## Trade-off accepted

Visibility is no longer glanceable before clicking Share. It is instead set at
share time, per publish, which the user accepted as the right moment.

## Testing

- Update `src/panels/Play/__tests__/StudioShare.test.tsx`: assertions that locate
  the visibility pills / tags input in the toolbar move to locating them inside the
  `coverStage === "confirm"` banner; the button query for
  `Share to app.agentgem.ai` becomes `Share` (name query), with the tooltip title
  asserted if convenient.
- Verify styled UI in a real browser (jsdom asserts behavior, not appearance):
  banner shows tags + pills in one wrapped row; toolbar shows only actions.

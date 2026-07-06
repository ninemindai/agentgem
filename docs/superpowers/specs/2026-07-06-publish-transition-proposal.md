# Proposal: make Publish handy & fast (fix the slow/confusing transition)

**Date:** 2026-07-06
**Status:** proposal → review → implement
**North star (user directive):** *"Publish should be very handy and easy — we should promote users to share."* Publishing to Explore is the critical contribution funnel; friction here costs shares.

## The problem (observed dogfooding)

Clicking Insights → **Publish** (the CTA in "Worth publishing"):

1. **Slow / frozen.** The handler `await`s `playbookPrepareRoute`, which runs a full server-side **distillation** (`computeDistill(root)` — AI analysis of the project's sessions) *behind the button*. The button sits on "Preparing…" for the whole distill (seconds to tens of seconds) with no progress, then navigates. A click that hangs reads as broken.
2. **Confusing destination.** It lands on Curate's **"Compose from artifacts"** tab — a dense workbench (search, "Used only", select-all/clear, workspace-name + Save, Materialize link, Checks) with the actual `PublishToExplore` form buried at the **bottom**. The user pressed "Publish" and got an artifact-composition workbench.
3. **Not handy.** Even once you find the form, the playbook path leaves the **name field empty** (only the "Share my setup" path prefills it), so the user must think up a name before they can publish. More friction on the funnel we most want frictionless.

## Design principles for the fix

- **Instant.** A click never hangs. Navigate first; do slow work in the destination with visible progress.
- **Focused.** Landing view = "publish this," not "compose artifacts." The workbench stays available, one disclosure away, for power users.
- **Pre-filled.** Scope, name, and version all default sensibly so publishing is one click. Editable, never required.
- **Promote the share.** The success state already returns a hosted share link — keep it celebratory and easy to copy/share, closing the loop.

## Options considered

| Option | Fixes slow | Fixes confusing | Handy (1-click) | Cost |
|---|---|---|---|---|
| A. Spinner only, keep prepare in Insights | ✗ (still hangs) | ✗ | ✗ | tiny |
| B. Navigate-first + prepare-in-Curate + scroll to form | ✓ | partial (still in workbench) | ✗ (empty name) | small |
| **C. Navigate-first + focused publish view + prefill (recommended)** | ✓ | ✓ | ✓ | medium |
| D. Brand-new dedicated publish route/modal | ✓ | ✓ | ✓ | large (new surface) |

**Recommend C** — it delivers the "very handy and easy" directive by reusing the existing `PublishToExplore` form (which already prefills scope from `@login` and shows the share link) presented as a focused step, without building a new surface (D) or leaving the funnel half-fixed (A/B).

## Recommended design (Option C)

**1. Insights "Publish" becomes instant.** Drop the `await prepare`. Set a pending playbook intent carrying just the project `root` and navigate immediately.
- `PendingPlaybook` becomes `{ root: string; skills?: string[]; lessons?: string[] }` — skills/lessons optional. Absent ⇒ Curate runs the prepare (new instant path); present ⇒ used directly (back-compat).

**2. Curate owns the prepare, with visible progress, in a focused publish mode.** When it consumes a `pendingPlaybook` that needs preparing, Curate:
- switches to the compose tab and enters `publishFocus` mode;
- renders a clean **"Publish <project> to Explore"** header + a progress line: *"Distilling <project> into a playbook…"* (not a frozen button);
- calls `playbookPrepareRoute`; on success populates the selection keys + counts and shows `PublishToExplore`; on error shows the message inline (no silent fail);
- in `publishFocus` mode the dense compose ledger is **collapsed behind a "Refine selection ▾" disclosure** so the publish form is the focus; power users expand it to tweak.

**3. Pre-fill the name.** Derive a default gem name from the project basename, sanitized to `[A-Za-z0-9._-]` (the workspace-name rule). Passed as `PublishToExplore`'s existing `defaultName`. Scope already prefills from `@login`; version stays `1.0.0`. ⇒ publish is one click.

**4. Promote the share (already mostly there).** `PublishToExplore`'s result shows `exploreRef` + the hosted `shareUrl` with Copy. Keep it; a follow-up can add X/LinkedIn intents like the Mine share card.

### What the user experiences after

Click **Publish** → *instantly* on a focused "Publish <project> to Explore" screen showing "Distilling…" progress → form appears with name/scope/version filled → click **Publish** → share link. No hang, no workbench detour, no naming homework.

## Scope

- `packages/console/src/pendingAnalyze.ts` — optional `skills`/`lessons` on `PendingPlaybook`.
- `packages/console/src/panels/Insights/index.tsx` — instant navigate (no await); button no longer needs the `contributing` spinner for the prepare.
- `packages/console/src/panels/Curate/index.tsx` — consume root-only playbook, run prepare with progress state, `publishFocus` mode (collapse ledger behind a disclosure), derive default name from root.
- Tests for each; verify live in the running app.

## Review resolutions (independent review, 2026-07-06 — "proceed with changes")

- **Empty distill guard (was the top risk):** `PublishToExplore.handleSubmit` guards only name/scope, not an empty selection — so a 0-skill/0-lesson distill would one-click-publish an empty gem. Fix: if prepare returns zero skills+lessons, render an empty state ("Nothing distilled worth publishing yet") instead of the form.
- **Surface `degraded`:** the prepare response carries `degraded`; thread it into the publish header as a "basic" chip (mirrors Insights `index.tsx:112`) so a thin distill is visible before publishing publicly.
- **Simpler than a `publishFocus` mode:** don't add a mode flag + ledger-collapse state. Just render the publish panel (progress | empty | form) **above** the ledger in the prepare path; leave the workbench below for power users. Same "publish is the focus" outcome, smaller diff.
- **Mount effect:** branch explicitly — `if (playbook.skills && playbook.lessons)` use the present path (back-compat, keeps existing tests green); else run prepare, and set `publishCounts`/keys from the *response*. Wrap the async prepare with the existing `alive` guard (`Curate/index.tsx:62`); StrictMode is already safe (consume-once module slot dedupes the double-invoke). Retain `root` in state so an error state can offer Retry.
- **Name prefill edges:** last non-empty path segment, sanitize to `[A-Za-z0-9._-]`, strip leading dots, fallback `"playbook"`; show "publishing as @login/&lt;name&gt;" so the (silently-overwriting) name is noticed.
- **a11y:** progress line is `aria-live="polite"`.

## Explicitly NOT in scope (follow-ups)

- A brand-new publish route/modal (Option D).
- Server-side distill performance (`computeDistill` is the real latency; this proposal fixes *perceived* speed via navigate-first + progress). A caching/streaming pass on distill is a separate perf item.
- Share intents (X/LinkedIn) on the publish result — a small follow-up.

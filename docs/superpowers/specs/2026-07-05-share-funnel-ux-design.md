# Share-to-app.agentgem.ai funnel UX — design

**Date:** 2026-07-05
**Status:** design approved, pending spec review → writing-plans
**Scope:** `packages/console/` (local desktop console UI only)

## Problem

Sharing to app.agentgem.ai (the public marketplace/Explore catalog) is a critical
funnel, and the console's foreground share paths have inconsistent friction. Two
hosted destinations do genuinely different things, but the UI blurs them:

- **Light — share card:** `POST /api/share` (`kind:"gem"`/`"certificate"`) → a
  hosted `/share/:id` marketing card. Minted 1-click inline (the Mine pattern).
- **Heavy — publish to Explore:** `createWorkspaceRoute` → `playbookPublishRoute`
  → an installable, versioned entry in the public catalog (scope + name + version).

Today the three "indirect" entry points (Observe "Share my setup",
TranscriptViewer lesson, Dreaming) all funnel into the **heavy** publish form
(`setPendingContribution(...)` → `#/curate`), turning a one-tap intent into a
context switch + a 3-field form + an inline OAuth detour (~8 actions). Meanwhile
Mine already proves the 1-click inline mint works.

## Goal

Give each surface both a fast **Share link** (1-click inline card) and a
deliberate **Publish** (catalog), so the default is 1 step and the catalog is an
opt-in — without duplicating the mint state machine or breaking the working Mine
surface.

## Locked decisions (brainstorming)

1. **Both paths, user chooses** — every surface where both are meaningful offers a
   light and a heavy path.
2. **Two buttons side by side** — `[ Share link ]` (primary) + `[ Publish ]`
   (secondary). Not a split-button or a menu.
3. **Light path reuses `kind:"gem"` cards** — `createGemShareRoute({ kind:"gem",
   name, provenance, generatedAtMs })`. No new backend card kinds, no hosted
   renderer work.

## Naming

- Light path button: **"Share link"** (when paired with Publish) → result is a
  `ShareLinks` row.
- Heavy path button: **"Publish"** → opens the **"Publish to Explore"** form.
- The form heading changes from "Share to Explore" → **"Publish to Explore"** so
  the word "Share" belongs exclusively to the light path.
- Mine's existing standalone buttons stay **"Share" / "Share gem"** (D5): they have
  no adjacent Publish button, so the "link" qualifier isn't needed and the working
  surface is left untouched.

## Architecture

New reusable unit: **`<QuickShareButton>`**
(`packages/console/src/panels/_shared/QuickShareButton.tsx`).

Encapsulates the light-mint state machine (in-flight / success / error /
cold-start-slow) and renders `[ Share link ]` + the inline `<ShareLinks>` result
row. It is the ONLY place this state machine lives; it lifts the logic that today
sits inline in `Mine/Scorecard.tsx:29-38` (including the `slow` ~3s→"waking the
server" hint for hosted cold starts).

```
Props: { apiBase, name, provenance, title, label?, disabled?, disabledReason? }
onClick → createGemShareRoute({ kind:"gem", name, provenance, generatedAtMs: Date.now() })
```

The three indirect surfaces supply `name`/`provenance`; cold-start, error, and
pending handling come for free.

## Per-surface behavior

| Surface | File | Light "Share link" | Heavy "Publish" |
|---|---|---|---|
| Observe "Share my setup" | `panels/Observe/index.tsx:65`, btn `Observe/Dashboard.tsx:59` | mint from inventory counts; result in a **dedicated strip between `obs-head` and `obs-filters`** | existing `setPendingContribution` → `#/curate` (now prefilled) |
| TranscriptViewer lesson | `panels/Observe/TranscriptViewer.tsx:258`, btn :270 | mint from lesson; result in a **strip below the lesson** | existing `pendingContribution` → `#/curate` |
| Dreaming opportunity | `panels/Dreaming/index.tsx:36`, btn :118 | **none** — single `[ Publish ]` only | existing `openOpportunity` → `#/curate` |

**Dreaming stays single-button (YAGNI):** a dream opportunity is a proposal to
build, not a finished artifact, so there's nothing concrete to mint a meaningful
card from. Two-button treatment applies only where a concrete artifact exists.

### Provenance strings (light path)
- Setup: `"{N} skills · {N} MCP · {N} hooks"` (from `inventoryRoute` counts).
- Lesson: its source-session summary.
- Workflow (Mine, existing): `"Distilled from {N} sessions"`.

## Design decisions from /plan-design-review (2026-07-05)

- **D2 — Result placement (Pass 1, Info Arch):** non-card surfaces get a
  **dedicated result strip below the trigger** (Observe: between `obs-head` and
  `obs-filters`; TranscriptViewer: below the lesson). `ShareLinks` is reused
  verbatim so the result looks identical to Mine. Accepted trade-off: Observe
  filters shift down while the strip is open.
- **D3 — Empty payload (Pass 2, States):** when the payload is empty (0 skills /
  no session), the **Share-link button is disabled with a reason** ("Nothing to
  share yet — add skills first" / "No session behind this lesson"). No hollow
  "0 skills" card can reach app.agentgem.ai. Mirrors how Mine's Build Gem disables
  at count 0 (`Workflows.tsx:224`). Implement as `aria-disabled` + a visible inline
  hint (NOT `title`-only) so keyboard/screen-reader users get the reason (Pass 6).
- **D4 — Upgrade nudge (Pass 3, Journey):** after the `ShareLinks` row resolves,
  show a quiet secondary line **"Want others to install this? Publish to Explore →"**
  that opens the prefilled form. Converts the warmest possible publish lead (someone
  who just shared) instead of dead-ending the fast path.
- **D5 — Label consistency (Pass 5):** context-varied — "Share link" only where
  paired with Publish; Mine keeps "Share"/"Share gem".
- **D6 — Visible form labels (Pass 6, A11y):** add visible `<label>`s (scope /
  name / version) above the `PublishToExplore` inputs. Prefill makes the
  placeholder-as-label vanish, leaving prefilled boxes unlabeled; visible labels
  fix the WCAG violation our prefill exposes.
- **D7 — OAuth placement (Pass 7):** keep the inline GitHub device-flow for now;
  deferred to a P2 TODO (see below).

### Prefill (original goal #1)
The `PublishToExplore` form arrives prefilled:
- `scope` ← `@${bindStatus.login}` (already fetched at `PublishToExplore.tsx:141`).
- `name` ← `consumePendingContribution().name` (Observe already sets
  `name: "my-setup"`).
- `version` ← keeps `1.0.0`.
- Focus lands on the first empty/actionable field, else the submit button.

## Interaction states (light path, via `<QuickShareButton>`)

| State | User sees |
|---|---|
| Idle | `[ Share link ]` enabled |
| Empty payload | `[ Share link ]` disabled + visible reason hint (D3) |
| Pending | spinner + "Creating link…"; past ~3s "Waking the server…" |
| Success | `ShareLinks` row in the result strip + upgrade nudge line (D4) |
| Error | inline error under the trigger ("Couldn't create a share link — try again.") |

## What already exists (reuse, don't rebuild)

- `ShareLinks.tsx` — copy input + X/LinkedIn/Facebook/More intents, pending state.
- Mine's mint state machine (`Scorecard.tsx:29-38`) — lift into `QuickShareButton`.
- Button classes `scorecard-share` / `mine-wf-share`, strip class
  `scorecard-share-links` (`theme.css:682`).
- `createGemShareRoute`, `playbookPublishRoute`, `bindStatusRoute` (routes.ts).
- No DESIGN.md; `theme.css` is the component vocabulary reference.

## NOT in scope

- **Moving GitHub verification out of the Publish form** — deferred to a TODO
  (D7); binding is already global via `bindStatusRoute`, so it's a clean separate
  change. Keeps this plan focused on the split + prefill.
- **New per-surface card kinds** (`setup`/`lesson`/`dream`) — rejected in
  brainstorming; reuse `kind:"gem"`.
- **Background/passive share** (`emitAdoption.ts`, `agentgem usage report`) —
  already frictionless; untouched.
- **Renaming Mine's buttons** — left as-is (D5).
- **Hosted card renderer changes** — none; light cards use the existing gem card.

## Implementation tasks

- [ ] **T1 (P1)** — `_shared/QuickShareButton.tsx` — new component that lifts
  Mine's mint state machine (pending/slow/error) and renders `[ Share link ]` +
  inline `ShareLinks`. Props per Architecture. Verify: unit test the 4 states +
  cold-start hint.
- [ ] **T2 (P1)** — `Observe/Dashboard.tsx` + `Observe/index.tsx` — add
  `[ Share link ]` beside "Share my setup" (now "Publish"), result strip between
  `obs-head` and `obs-filters`; disable Share-link when inventory is empty (D3).
- [ ] **T3 (P1)** — `Observe/TranscriptViewer.tsx` — two-button row on the lesson;
  result strip below the lesson; disable when no session (D3).
- [ ] **T4 (P2)** — `Dreaming/index.tsx` — rename to single `[ Publish ]` (no light
  path); ensure it routes into the prefilled form.
- [ ] **T5 (P1)** — `Curate/PublishToExplore.tsx` — prefill scope/name/version;
  add visible `<label>`s (D6); rename heading "Share to Explore" → "Publish to
  Explore"; focus first empty field.
- [ ] **T6 (P2)** — post-mint upgrade nudge line under `ShareLinks` (D4), wired to
  open the prefilled Publish form.
- [ ] **T7 (P2)** — CSS for the result strip on non-card surfaces (reuse
  `scorecard-share-links`), and the disabled-reason hint styling.

## Deferred TODO

- **Move GitHub verification to Settings/onboarding (P2).** Why: the inline
  device-flow adds weight and a mid-form detour with confusing copy ("Share
  telemetry once first"). Binding is already global (`bindStatusRoute`), so publish
  can read bound state without an inline connect. Blocked by: nothing; clean
  follow-up after this ships.

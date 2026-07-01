# Gem-share on-ramps: "Share my setup" (Inspect) and "Share" a distilled lesson

## Goal

Let a user turn two things into a **shareable, installable Gem bundle** — so others
can `apply` it to set up their own coding agent:

1. **Inspect → "Share my setup"** — bundle the whole `/api/inventory`
   (skills + MCP servers + instructions + hooks) into a **Setup** gem.
2. **Distilled lesson → "Share"** — bundle a saved lesson into a gem.

Both reuse the existing distribution spine. **No server changes.**

## Why this is small

The pipeline already exists end to end:

- `POST /api/workspaces` (`createWorkspaceRoute`) builds + persists a gem from a
  `GemSelection` server-side.
- `PublishToExplore` (`packages/console/src/panels/Curate/PublishToExplore.tsx`)
  already does `createWorkspace` → `playbookPublishRoute` → `{ exploreRef, shareUrl }`
  (registry ref = installable, share URL = unfurl card).
- The Insights panel already hands a *project playbook* into Curate via a one-shot
  `pendingPlaybook` slot that pre-selects keys and shows `PublishToExplore`.
- A **saved** distilled lesson (`.agentgem/distilled/lessons/<name>.md`) is scanned
  into `/api/inventory` as an `instructions` artifact named `<name>`
  (`packages/capture/src/introspect.ts:224-233`), so it is selectable.
- Gem type auto-classifies: a whole-inventory gem → **Setup (Opal)** cut
  (`packages/model/src/gemTypes.ts`).

So the only new code is a generalized hand-off + two buttons.

## Design

### 1. Generalized one-shot hand-off (additive)

`packages/console/src/pendingAnalyze.ts` — add a slot alongside the existing
`pendingAnalyze` / `pendingPlaybook` (both untouched):

```ts
export interface PendingContribution {
  keys: string[];        // selection keys, e.g. "skills::x", "instructions::y"
  skillCount: number;    // for the publish provenance line
  lessonCount: number;
  name?: string;         // default workspace name
}
setPendingContribution(d) / consumePendingContribution()  // read-and-clear once
```

`packages/console/src/panels/Curate/index.tsx` useEffect gains one branch:

```ts
const contrib = consumePendingContribution();
if (contrib) {
  setKeys(new Set(contrib.keys));
  if (contrib.name) setNameStore(contrib.name);
  setTab("compose");
  setShowPublish(true);
  setPublishCounts({ skills: contrib.skillCount, lessons: contrib.lessonCount });
}
```

### 2. On-ramp A — Inspect "Share my setup"

`Dashboard.tsx` header gets a **Share my setup** button (optional `onShareSetup`
prop). `Observe/index.tsx` supplies the handler:

1. `inventoryRoute.call(client)` (lazy — only on click).
2. Build all keys: `skills::`, `mcpServers::`, `instructions::`, `hooks::`.
3. `setPendingContribution({ keys, skillCount: inv.skills.length, lessonCount: 0, name: "my-setup" })`.
4. `window.location.hash = "#/curate"`.

Lands in Curate with everything selected and the Publish form open.

### 3. On-ramp B — Distilled lesson "Share"

`LessonCard` (`TranscriptViewer.tsx`) gets a **Share** action revealed after the
lesson is saved (save writes it to inventory, which the gem build resolves):

- `setPendingContribution({ keys: ["instructions::" + lesson.name], skillCount: 0, lessonCount: 1, name: lesson.name })`
- `window.location.hash = "#/curate"`

### Per-instruction granularity (follow-up — now implemented)

Originally `buildSelection` collapsed instructions to `includeInstructions: true`
(all-or-nothing), so a lesson gem also carried every other instruction. Resolved:
`GemSelection` gained an `instructions?: string[]` field (name-resolved in `buildGem`
like skills/hooks, throwing on an unknown name), `includeInstructions` is kept for
back-compat, and `buildSelection` now emits the named subset. A single lesson's
"Share" therefore bundles only that lesson; the Insights "Contribute" flow likewise
now carries just its playbook lessons, not all CLAUDE.md instructions.

## Testing

- `pendingAnalyze.test.ts` — `setPendingContribution` / `consumePendingContribution` round-trip + consume-once.
- `Curate.test.tsx` — a pending contribution pre-selects the keys and shows the publish form.
- Manual: run the app, click both on-ramps, confirm landing state.

## Non-goals (v1)

- Per-instruction selection granularity.
- A dedicated "setup" or "lesson" share-card *kind* (we reuse the installable
  publish path, not the teaser card).
- The parked **Insights → visual charts** track (separate spec).

# Design — Console IA redesign: the produce-a-Gem journey

Date: 2026-06-28
Status: design approved in brainstorming; implementation NOT started.
Scope: information architecture / navigation of the React console (`packages/console`).
This is a **re-grouping and re-labeling of existing surfaces**, not a rebuild — most panels
already exist and move largely intact.

## Problem

The console's left nav is a flat list of metaphor-named panels — **Testbed · Ledger ·
Workspaces · Get Gems · Deploy** — that mixes three unrelated things: pipeline stages, a
*consume* flow (Get Gems), and *settings* (Deploy = credentials/backends). The original vanilla
UI had a journey **stage rail** (`Testbed → Package → Workspace → Target → Deploy`); the React
rewrite flattened it, and the journey structure was lost. Users can't map the panels to the
mental model of producing a Gem.

## Mental model (the journey)

A developer installs agentgem, then:
1. **Discover** — agentgem reads local agent configs (Claude Code, Codex, …) + session
   transcripts → knows what artifacts (skills, MCP servers, instructions, hooks) exist and which
   local projects had agent sessions. **Automatic; ambient — not a destination.**
2. **Curate** — hand-pick artifacts (global or per-project) OR **Analyze** a project's sessions
   to distill recurring workflows + their artifacts → assembles a **Gem manifest**.
3. **Materialize** — render the Gem into a concrete bundle for a target harness (Eve, Flue,
   AgentCore, …), or export the portable `.gem`; optionally test-run it.
4. **Deploy** — ship the Gem to an execution environment.

## Decisions (settled in brainstorming)

- **3 produce stages**, not 4 or 2: **Curate · Materialize · Deploy**. Discover is *ambient*
  (the discovered inventory + projects you curate FROM), surfaced inside Curate — not its own nav
  destination.
- **Top-level split: Build vs Library.** BUILD = the pipeline. LIBRARY = "Gems you have" (saved +
  installed + received). Settings is config, not a stage → moves to a footer gear.
- **Gem-centric flow.** BUILD always has ONE active Gem (the in-progress manifest). The three
  stages are steps on that same object. Start a New Gem in Curate, or Open a saved one from
  Library to revise/re-materialize/re-deploy.
- **Grouped-sidebar layout** (one persistent sidebar; smallest change from today, lowest risk
  alongside the concurrent transfer-UI work).
- **"Testbed" is removed entirely** — no testbed noun, no scaffold/import-to-testbed actions. The
  thing you curate from is just a **Project** (a discovered local project + its sessions),
  selected via Curate's scope picker.

## Navigation structure

```
◆ AgentGem
░ active-gem ░          ← pinned: name of the Gem being built (or "New Gem · N artifacts")
BUILD
 ① Curate              ← Ledger  +  Analyze (moved out of Testbed)
 ② Materialize         ← Targets (promoted out of the Ledger build flow) + Export + Test-run
 ③ Deploy              ← Workspace-deploy + Publish
LIBRARY
 Your Gems             ← Workspaces, reframed as "gems you own"
 Get Gems              ← Get Gems (registry search/install)
 Received              ← home for the transfer-receive UI (other session)
⚙ Settings             ← Deploy panel (credentials + backend readiness)
```

### Migration map (current surface → new home)

| Today | New home |
|---|---|
| Testbed: discovered projects, recents | Curate **scope picker** (Global ⇄ a Project) |
| Testbed: Analyze sessions → suggest | Curate: **Analyze** mode (pre-checks recommended artifacts) |
| Testbed: scaffold / import-to-testbed | **Dropped** from primary IA (see Open Items) |
| Ledger: inventory, filter, view-content, usage, checks, save | **① Curate** |
| Ledger build flow → Targets section | **② Materialize** (promoted to a stage) |
| Ledger build flow → Preview export (.gem/JSON/copy) | **② Materialize** → Export |
| Ledger build flow → Run (ACP local agent) | **② Materialize** → Test-run |
| Workspaces (list/save/render/delete) | **Library → Your Gems** |
| Workspace deploy (run local/vercel/cloudflare) + Publish (managed/agentcore) | **③ Deploy** |
| Get Gems (registry) | **Library → Get Gems** |
| Deploy panel (credentials + readiness) | **⚙ Settings** |
| (future) transfer redeem UI | **Library → Received** |

## Stage detail

### ① Curate
Assembles the active Gem's contents. Top: a **scope picker** — the only remnant of "Testbed".
- **Scope = Global** → user-level artifacts across agents (`~/.claude`, `~/.codex`, …) — today's
  inventory.
- **Scope = a Project** → that project's `.claude/` artifacts + its sessions become available.
  The dropdown lists discovered **Projects** (places agents have run).

Two ways to fill the Gem, side by side:
1. **Hand-pick** — the inventory list (filter, sort, view-content with Markdown⇄Raw, usage
   badges). Checking items adds them to the active Gem.
2. **Analyze** — only with a Project selected: distills that project's sessions → recommended
   workflow + artifacts and **pre-checks them** (the existing analyze → "Use this selection"
   flow, now inside Curate).

Also in Curate, on the active Gem: **Suggest checks**, **name the Gem**, **Save to Library**.

### ② Materialize
"Render the active Gem into something concrete." Three actions:
- **Materialize for a target harness** (claude/codex/agents/hermes/eve/flue/openai-sandbox/
  agentcore/a2a) → file tree + content viewer (Markdown view), compatibility/skipped counts.
- **Export portable `.gem`** / Download JSON / Copy → the neutral, shareable archive. Natural
  future home for "share via transfer".
- **Test-run with a local agent** (claude/codex) → the ACP run that verifies the Gem does its
  job, streamed.

### ③ Deploy
"Ship the active Gem to an execution environment."
- Pick an environment: **Run locally / Vercel (eve) / Cloudflare (flue) / Managed Agents /
  AgentCore**, with live status + URL + Stop + Undeploy.
- **Readiness gating** comes from Settings (credentials present → environment enabled).
- **Save dependency:** the web-app environments (eve/flue) render to a saved workspace dir, so
  Deploy prompts **"Save to Library first"** for those; managed environments (Managed
  Agents / AgentCore) work straight from the active selection.

## Library & Settings

- **Your Gems** — saved Gems (name · `gemName@version` · count chips · rendered targets). Actions:
  **Open** (→ active Gem, jump to Build), **Render**, **Delete**.
- **Get Gems** — registry search/install; installs land in Your Gems.
- **Received** — transfer-receive UI home (other session); received Gems land in Your Gems.
- **⚙ Settings** — credential management (ANTHROPIC_API_KEY, VERCEL_TOKEN, CLOUDFLARE_API_TOKEN) +
  backend-readiness dashboard; drives Deploy gating.

## Active-Gem mechanics

- **Pinned indicator** atop the sidebar shows the active Gem (name, or "New Gem · N artifacts").
- **Start:** "New Gem" (clears selection) or **Open** from Your Gems.
- **Carries through stages:** Curate's selection *is* the active Gem; Materialize & Deploy operate
  on it.
- **Save:** "Save to Library" names + persists (createWorkspace).
- **Soft gating (NOT a locked wizard):** all three stages always clickable. Materialize/Deploy on
  an empty Gem show an empty-state nudge ("Curate some artifacts first →") rather than being
  disabled — respects the journey without trapping power users.
- **Landing screen:** open app → **Curate** with a fresh New Gem (producing is the primary job);
  Your Gems is one click away.

## Component / file structure (implementation shape)

The console keeps its composable `ConsolePage` registry. Net change is **fewer top-level pages,
grouped, with stages as sub-nav**:
- `Shell.tsx` grows a notion of **groups** (BUILD / LIBRARY) + a footer (Settings) + the pinned
  active-Gem indicator. Today it renders a flat `pages` list sorted by `order`; it gains a
  `group` field per page and renders labeled sections.
- A small **active-Gem store** (like the existing `recommendation.ts` hand-off) holds the current
  selection/name/saved-id and is shared by Curate/Materialize/Deploy instead of Ledger-local
  state. This is the central refactor: today selection state lives inside `panels/Ledger/index.tsx`.
- **Curate** = `panels/Ledger/*` + the Analyze pieces from `panels/Testbed/*`, behind a scope
  picker. **Materialize** = `panels/Ledger/Targets.tsx` + `Preview`/export + `Run.tsx`, promoted.
  **Deploy** = `panels/Workspaces/WorkspaceDeploy.tsx` + `panels/Ledger/Publish.tsx`. **Your Gems**
  = the rest of `panels/Workspaces`. **Get Gems** unchanged. **Settings** = `panels/Deploy`.

## Open items (resolve at implementation time)

- **Re-Curate from a saved Gem:** a workspace stores the built manifest, not the original
  selection. "Open" cleanly supports Materialize/Deploy; restoring the *selection* into Curate may
  need a backend change (persist selection alongside the workspace) — confirm before promising
  full round-trip re-curate.
- **Scaffold / import-to-project:** dropped from the primary IA. If still wanted, add a small
  "＋ New / import project" action in Curate's scope picker — not a destination.
- **Active-Gem switching:** v1 = the pin reflects the one Gem you started/opened; a multi-Gem
  switcher dropdown is a later nicety.

## Non-goals

- No backend/API changes required for the IA itself (it re-arranges existing calls). The one
  possible exception is persisting selection for re-Curate (Open Item above).
- Not changing the warm-letterpress visual theme — only structure/navigation.
- Not porting the transfer redeem UI (separate session); this spec only reserves its home
  (Library → Received).

## Coordination

Implementation touches `packages/console` shell + page registry — the **same package a
concurrent session is editing for the transfer UI**. Sequence the IA implementation **after that
work merges** to avoid restructuring files mid-flight. This spec is safe to land now (docs only).

## Testing

- Console package: `Shell` group rendering + active-Gem pin; the active-Gem store (start/open/
  save/clear) as a pure unit; stage empty-state nudges; scope-picker switching Global ⇄ Project.
- Keep the existing per-panel tests; they move with their panels.
- Browser-verify the full journey: New Gem → Curate (hand-pick + Analyze) → Materialize (target
  preview + export + test-run) → Save → Deploy, plus Library Open round-trip.

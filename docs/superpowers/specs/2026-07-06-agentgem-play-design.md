# AgentGem "Play" — Mini-Games from Sessions, Skills & Projects

**Date:** 2026-07-06
**Status:** Design approved; ready for implementation plan
**Branch:** `feat/play-mini-games`

## Summary

Add **Play** to AgentGem: a way to turn a coding **session**, **skill**, or
**project** into a small, self-contained mini-game that runs inside the app and
can be published/shared like any gem.

The core flow:

> source (session / skill / project) + a genre **scaffold** → an ACP agent
> **writes the game code** (self-repairing against a validation gate) →
> **pre-bundled**, self-contained game → saved as a **`game` gem** → runs in the
> in-app **Play** runtime (a sealed sandboxed iframe) → **Publish/Share** via the
> existing marketplace.

The defining architectural consequence of **pre-bundled**: generation happens
**once at author time, not per play**. The Play runtime runs a static,
self-contained HTML bundle in a sandbox — no LLM at runtime, no network, offline.

Play slots into existing seams almost entirely. The only genuinely new machinery
is the **authoring pipeline** (source → scaffold → AI writes code → validate →
bundle). Everything else — the runtime, the safety sandbox, the gem lifecycle,
the tab system — is reused.

## Goals

- Generate a playable mini-game from a local source with a single action.
- Games are **first-class gems**: they archive, publish, share, and list in the
  marketplace using the existing pipeline, with zero new transport.
- Games are **safe to share**: a downloaded game is sealed and cannot reach the
  network, the filesystem, or the recipient's local AgentGem API.
- v1 proves the whole pipeline end-to-end on three genres.

## Non-Goals (v1)

- **Team competition** genre (needs a social/hosted/multiplayer layer) — deferred
  to v2. The template system is designed to accept it without a breaking change.
- **Live "Session watch"** genre and the **`invoke-agent`** capability — deferred.
  All three v1 genres are Offline. The permission model, brokers, and consent UX
  land in Plan 3 (see Permissions Model); the `GameCapability` type + `needs` field
  land in Plan 1 so no later addition is a breaking change.
- Automated *visual* verification of generated games (human preview is the visual
  gate in v1).
- A runtime LLM. Games are static bundles.

## v1 Scope: Three Genres

The template system is genre-agnostic; v1 ships three genres, all of which are
**pure sealed snapshots** (no live-data `needs`):

| Genre          | Source              | Rides on (existing)                                   | Notes |
|----------------|---------------------|-------------------------------------------------------|-------|
| `replay`       | one session         | `get_session_transcript`, transcript index            | Flagship; richest data, highest "wow" |
| `skill-run`    | a skill gem         | `packages/run` + testbed + `gemVerify`                | Distinctly AgentGem; a playable skill challenge |
| `project-fun`  | a project dir       | `discoverProjects` (`testbedFlavors.ts`)              | Lightest; mostly theming/stats |

Deferred genres (design accommodates, not built): `watch` (live session
spectator, uses the broker), `team` (org-usage leaderboard, needs hosted/social).

## Architecture

One new package, one new console panel, one artifact-type extension. Everything
else reuses existing seams.

```
packages/play/                     ← NEW: authoring engine (server-side, genre-agnostic)
  src/
    genres.ts        GameGenre registry (replay | skill-run | project-fun)
    scaffolds/       one runnable HTML scaffold per genre (hand-built)
    sourceContext.ts extract source data (session/skill/project) → GenerationInput
    generateGame.ts  drive ACP self-repair loop → validated { html, poster, meta }
    gameGate.ts      Tier-1 validation: static checks + jsdom smoke load
    broker.ts        sanitizer + policy for the (dormant in v1) live feed

packages/console/src/panels/Play/  ← NEW: UI (mirrors panels/Watch structure)
  index.tsx          playPage = defineConsolePage({ id:"play", group:"build", … })
  Composer.tsx       pick source → pick genre → generate (live SSE progress)
  Arcade.tsx         grid of your game gems (filtered by the "game" cut); play/share
  Runner.tsx         sealed sandboxed iframe (reuses sandboxDoc.ts) + play controls + broker

packages/model/src/types.ts        ← EDIT: add "game" to ArtifactType + GameArtifact
packages/model/src/gemTypes.ts     ← EDIT: add a "game" cut (gemstone "Amethyst")
```

### Why a new `packages/play`

Generation drives an **ACP agent** server-side (reusing `packages/run`'s
testbed + sandbox); it cannot live in the browser SPA. The console `Play` panel
is a thin client that calls core routes (`POST /api/play/generate` → SSE
progress), mirroring the existing console↔core split used by Watch.

### Reused wholesale (no new machinery)

- **Runtime & safety** → `packages/console/src/panels/Watch/sandboxDoc.ts` — the
  null-origin sandboxed iframe with strict CSP
  (`sandbox="allow-scripts"`, no `allow-same-origin`; `default-src 'none'`;
  inline script/style; `img/font/media-src data:`). Rendered exactly as
  `panels/Watch/index.tsx:74-80` renders agent-produced HTML today.
- **Generation boundary** → `packages/run/src/{runGem,sandbox,sandboxLaunch}.ts`
  and `packages/testbed/src/testbed.ts` — jailed testbed dir with sensitive
  paths masked; opaque `runId` registry so a request can't point at arbitrary
  paths.
- **Gem lifecycle** → archive, publish (`exploreRef`/`shareUrl`,
  `routes.ts:680-689`), hosted archive store (`gem_archives`), and marketplace —
  all work once `game` is a known artifact type.
- **Tab registration** → `ConsolePage` contract (`contract.ts:3-18`); one import
  + one array entry in `pages.tsx`; placed in the **"build"** sidebar group.

## The `game` Artifact

A game is a new `ArtifactType`, making it a first-class gem.

```ts
// packages/model/src/types.ts
type ArtifactType = "skill" | "mcp_server" | "instructions"
                  | "hook" | "channel" | "subagent" | "game";   // + game

type GameGenre = "replay" | "skill-run" | "project-fun";        // v2: "watch" | "team"
type GameCapability =                                           // declared permission ladder (see Permissions Model)
  | "live-session-events"   // read-only: streamed live sessions (host-brokered)
  | "local-project-access"  // read-only: local projects / setup / inventory (host-brokered)
  | "invoke-agent";         // privileged: host runs a local ACP agent in the sandbox (local-authored only)

interface GameArtifact {
  type: "game";
  name: string;             // slug, e.g. "auth-bugfix-replay"
  title: string;            // display, e.g. "The Great Auth Bug Hunt"
  genre: GameGenre;
  html: string;             // THE pre-bundled, self-contained game (inline JS/CSS, data: assets)
  poster?: string;          // data-URI thumbnail — the preview gate's screenshot
  createdFrom: GameSource;  // provenance reference + summary, NOT the raw source
  engineVersion: string;    // scaffold/genre version, for future migration
  needs?: GameCapability[]; // declared, read-only; host decides whether to feed. Absent = pure snapshot.
  meta?: { controls?: string; estPlaySeconds?: number };
}

// Provenance is a lightweight reference + summary — the data itself is baked into html.
type GameSource =
  | { kind: "session"; agent: string; project?: string; sessionId: string; summary: string }
  | { kind: "skill";   skillName: string; sourceId?: string }
  | { kind: "project"; path: string; flavor: string };
```

`GameArtifact` joins the `GemArtifact` union (`types.ts:97`). A **new cut** in
`gemTypes.ts` (mirroring the existing `skill` cut) —
`{ id: "game", label: "Game", gemstone: "Amethyst" }` — matches gems whose
artifacts are all `type === "game"`, giving games their own chip, marketplace
filter, and archive behavior.

Games do **not** use the agent-verification fields on `Gem` (`checks`,
`contract`); those stay optional and unused, since a game is run by the Play
iframe, not by an ACP agent.

### Deliberate choices

1. **`html` is baked, self-contained, offline.** It carries its own inline JS/CSS
   and `data:` assets — the Play iframe just runs it. No runtime LLM, no network
   (CSP forbids it). This is the point of "pre-bundled." The `html` travels in the
   gem archive / hosted store like any artifact payload.
2. **Provenance ≠ source data (privacy).** `createdFrom` stores a *reference + a
   one-line summary*, never raw transcript/code. Honest caveat: a **session
   replay necessarily bakes session-derived content into `html`**, so sharing that
   gem shares whatever the game visualizes. The preview gate shows exactly what is
   baked before save/share; sharing rides the existing publish-consent flow.
3. **`needs` declared up front.** v1's three genres have no `needs` (pure
   snapshots), but the field exists now so adding a live genre later is additive,
   not a breaking model change.

## Authoring Pipeline (source → self-repairing generation)

Server-side ACP loop, streamed to the console via SSE (like Watch's stream).

```
  Composer.tsx (console)                    packages/play (core)
  ─────────────────────                     ────────────────────
  1. pick source ───────► POST /api/play/generate  { genre, sourceRef }
     (session / skill /                     │
      project picker)                       ▼
  2. pick genre ──────────►  sourceContext.ts  extract → GenerationInput
                                             │   session: get_session_transcript → timeline+stats
                                             │   skill:   read SKILL.md + metadata
                                             │   project: discoverProjects + signature
                                             ▼
  3. Generate ◄─SSE progress─  generateGame.ts
     (live agent log)                        │  scaffold = scaffolds/<genre>.html
                                             │  testbed  = packages/run sandbox (jailed)
                                             │  ACP loop: agent writes game INTO scaffold,
                                             │     runs it, sees gate errors, fixes, repeats
                                             │     until gameGate passes or budget hit
                                             ▼
  4. Preview ◄─────────────  validated { html, poster, meta }  (held by opaque runId)
     (play it in the gate iframe)            │
  5. Approve ─────────────► save as game gem (GameArtifact) in your inventory
```

### Key points

- **`sourceContext.ts` is the only genre-aware extractor.** Each genre declares
  how to turn its source into a compact `GenerationInput` (a JSON brief + the data
  payload the game bakes in). This seam keeps genres isolated: adding a genre =
  one new extractor + one scaffold, nothing else changes.
- **The scaffold is a real, runnable starting point** — a canvas/DOM skeleton
  pre-wired with the sealed-bundle conventions (inline everything, `data:` assets,
  a `postMessage` stub when `needs` is declared). The agent rewrites the game logic
  *within* it. The scaffold guarantees CSP-clean shape before the agent starts.
- **Generation reuses the run/testbed sandbox** exactly as gem-runs do; sensitive
  paths are masked so a generation prompt can't reach the real `.claude/` or
  settings. The self-repair loop is **bounded** (max iterations / token budget);
  on exhaustion it returns the best passing attempt or a clear failure.
- **Nothing is saved until approval.** The candidate is held in memory keyed by an
  opaque `runId` (same pattern as `RUN_REGISTRY`); it becomes a gem only at step 5.

## Validation Gate (two tiers)

Verifying a *visual* game fully needs a real browser, but we do not want headless
Chrome in core. The gate is split by what each environment can cheaply prove.

**Tier 1 — generation-time (server, deterministic).** The self-repair signal and
the admission check before preview; runs independent of the agent's self-report.
`gameGate.ts`:
- **Self-contained check** — no external `src`/`href`/`fetch`/`import`; only inline
  JS/CSS and `data:` assets. (A game that reaches the network fails here — this is
  what keeps it sealed and shareable.)
- **Parse + load smoke** — execute inline scripts in a **jsdom** context (light
  dependency, not full Chrome); catch uncaught throws in the first tick. Catches
  the large class of "broken on load" failures.
- **Budgets** — bundle size (archives/shares well) and a `needs` sanity check
  (only known capabilities).

**Tier 2 — preview-time (console, real browser).** The human preview *is* the
final visual gate. You play the candidate in the actual sealed iframe before
approving; the console captures the **poster screenshot** from the real canvas.
No server headless browser needed.

**Honest tradeoff:** jsdom cannot see a blank canvas or a broken animation — so
the agent self-repairs *crashes and load errors* automatically, while *visual*
correctness is caught by the human at preview. A browser-side smoke (dispatch a
click/key, assert canvas non-blank) can graduate into a "Tier 1.5" later; v1 does
not need it.

## Play Runtime, Broker & Sharing

### Runtime (`Runner.tsx`)

Reuses Watch's sealed iframe verbatim:

```
GameArtifact.html ─► sandboxDoc(html) ─► <iframe sandbox="allow-scripts" srcDoc=…>
                     (default-src 'none'; script/style inline; img/media data:)
```

Controls around it: restart, mute, fullscreen-within-panel, share. Because the
bundle is self-contained, it plays instantly and offline. `Arcade.tsx` is the grid
of your game gems (filtered by the `game` cut), each showing its poster.

### Permissions model (the capability ladder)

A game **declares** the capabilities it wants via `needs`; the trusted Play host —
never the game — decides whether to grant them, consent-gated per gem. **Games
never get direct localhost / filesystem / network access — full stop.** Each
capability is a permission tier the user sees as a chip on the game card and
approves at first play:

| Tier | `needs` value | Chip | What the game may access | Access |
|------|---------------|------|--------------------------|--------|
| **Offline** (default) | *(absent)* | 🟢 offline | only its baked-in snapshot | none — pure sealed iframe |
| **Live sessions** | `live-session-events` | 🔴 live | streamed live session events | read-only, host-brokered |
| **Local project** | `local-project-access` | 🟡 local | your projects / setup / inventory | read-only, host-brokered |
| **Invoke agent** | `invoke-agent` | ⚙️ agent | runs a local ACP agent, gets its transcript | privileged, host-run in the run-sandbox |

All three non-offline tiers are strictly **read-only into the sealed game** — the
host forwards data/results in; the game can never write, act, or reach the network
(CSP blocks it). Consent is per-gem and remembered, **except `invoke-agent`, which
re-prompts per run** and shows a visible "this game is running an agent" banner.

**Read-only data feeds** (`live-session-events`, `local-project-access`) — the host
(console code, which legitimately talks to core over localhost) fetches and forwards
a narrow, sanitized slice via `postMessage`:

```
game (sealed)                         Play host (Runner.tsx, trusted, localhost)
  │  postMessage {type:"agentgem:request",          │
  │               want:"live-session-events"} ──────►│ 1. is "want" in the gem's declared needs?
  │                                                  │ 2. consent gate (per-gem, remembered)
  │  ◄─ postMessage {type:"agentgem:feed", ─────────│ 3. subscribe the source (e.g. /api/watch/stream)
  │      channel, event:<sanitized>}                 │ 4. forward a SANITIZED read-only slice
```

**Privileged execution** (`invoke-agent`) — the game requests a run; the **host**
drives a local ACP agent through the *exact same* `packages/run` sandbox that
gem-runs already use (jailed testbed, masked sensitive paths, capability-gated
permission model), and streams back only a **sanitized transcript**. Because this is
code execution, not data access, it is gated hardest: **disabled for
shared/marketplace games by default — enabled only for games you authored locally**
(a downloaded game asking to run agents on your machine is exactly the supply-chain
risk this design guards against), plus per-run consent and a visible banner.

Guarantees that hold for every tier:
- **Declared-or-denied** — the host refuses any `want` not in the gem's `needs`.
- **Sanitized** — the host forwards only what the tier needs, stripping file paths
  and raw code/transcript text (same anti-leak discipline as Team Pulse attribution).
- **Local-only, one-way** — data/results flow to *your* running game on *your*
  machine, never the reverse; the game cannot exfiltrate because CSP blocks all
  network. A downloaded game prompts *your* consent or gets nothing — it can never
  silently reach a publisher's data or (for `invoke-agent`) run at all.

**Why not direct localhost access:** loosening CSP to `connect-src
http://localhost:PORT` would let any downloaded game hit the recipient's local
AgentGem API (inventory, sessions, settings, runs) — a supply-chain hole. The
broker gives the same *capabilities* with none of that exposure. Rejected as a
design option.

**Build phasing:** v1's three genres are all Offline (`needs` absent). The
permission model, chips, consent gates, and brokers land in **Plan 3** (the console
surface); the `GameCapability` type and `needs` field land now (Plan 1) so the
model is complete and no later change is breaking. `invoke-agent` and the live
genres that use these tiers are built after the offline pipeline is proven.

### Sharing

Rides the existing gem pipeline with zero new transport:
- Publishes via current `exploreRef`/`shareUrl` routes; `html` travels in the gem
  archive / hosted store (`gem_archives`).
- Lists in the marketplace filtered by the `game` cut.
- The existing **"Open in AgentGem" installable deep-link** makes a shared game
  one-click install-and-play.
- Publish keeps the current consent flow, plus one game-specific line at the gate:
  *"This game may contain data from your session/skill/project — anyone you share
  it with can see it."*
- **Optional, not built:** the marketplace could play a game in-browser using the
  same CSP sandbox — safe by the same rules.

## Testing

- **`packages/play` unit tests:** `sourceContext` extractors
  (session/skill/project → `GenerationInput`) with fixtures; `gameGate` static +
  jsdom checks (known-good and known-broken HTML → assert pass/fail); the broker
  sanitizer (paths/code stripped, only declared `wants` honored).
- **Genre golden tests:** each scaffold, run through the gate empty, must pass
  Tier-1 (proves scaffolds ship CSP-clean and runnable).
- **Console:** `Runner` renders a fixture game in the sandboxed iframe; the broker
  consent gate blocks an undeclared `want`. (Console tests run locally — not in
  CI, per the repo's known gap.)
- **Generation loop:** mock the ACP driver so `generateGame` is testable without a
  live agent — assert it iterates on gate failure and stops at budget.

## Open Questions / Future Work

- v2 genres: `watch` (activates the broker), `team` (needs hosted/social layer).
- Automated visual verification ("Tier 1.5").
- In-marketplace play-in-browser preview.
- Whether large `html` bundles should always be archive assets vs. inline (size
  threshold) — deferred to the archive layer's existing conventions.

## Landmarks (existing code this design builds on)

- Tab system: `packages/console/src/contract.ts`, `pages.tsx`, `registry.ts`,
  `shell/Shell.tsx`; copy `panels/Watch/index.tsx`.
- Sealed runtime: `panels/Watch/sandboxDoc.ts` + `panels/Watch/index.tsx:74-80`.
- Run/testbed boundary: `packages/run/src/{runGem,sandbox,sandboxLaunch}.ts`,
  `packages/testbed/src/testbed.ts`, `testbedFlavors.ts` (`discoverProjects`).
- Sources: `src/watchSessions.ts`, `get_session_transcript`
  (`src/goldmine/mcpServer.ts`), `packages/insight/src/{sources,skillsRegistry}.ts`.
- Gem model: `packages/model/src/types.ts` (Gem/artifact union),
  `gemTypes.ts` (cuts); publish/share `packages/console/src/api/routes.ts:680-689`.

---

## Revision 2026-07-06 — Storage, Studio & decomposition (supersedes the persistence + generation UX above)

Design evolved during Plan-2 planning. The **artifact model, cut, gate, and permission
ladder (Plan 1, landed) are unchanged.** What changed is *where miniapps live* and *how
they're built*. "Game" remains the only artifact type; "miniapp" is the umbrella term for
these self-contained interactive HTML artifacts (a game is one kind). No artifact-type
generalization — decided to keep `game` for now.

### Storage — a git-backed miniapps registry, dual-written with the gem store

Miniapps live in a **local git repository** at `~/.agentgem/miniapps/` (sibling of
`~/.agentgem/workspaces/`, same `AGENTGEM_HOME` convention as `workspacesRoot()`):

```
~/.agentgem/miniapps/            ← a git repo (git remote → a shared registry)
  <name>/<name>.html             ← the sealed, self-contained bundle
  <name>/meta.json               ← { title, genre, createdFrom, needs?, engineVersion }
```

On **save**, the bundle is **dual-written**: (1) into the miniapps git repo (`git add` +
`git commit`), and (2) as a one-artifact `game` gem via `createWorkspace(name, gem)` — kept
in sync so a miniapp is simultaneously a shareable HTML file *and* a marketplace-capable gem.
**Publish/share = `git push`** to a remote registry (the local repo's `origin`). Note: the
existing "GitHub registry" (`packages/distribute`) is pure HTTP over GitHub's API with **no
local-git plumbing** — so the miniapps registry gets a **new thin `child_process` git
wrapper** (`spawn("git", …)`; no new dependency, git-on-PATH required). `gameGate` runs as the
admission check **before** each commit; a bundle that fails the gate is never committed.

### Studio — reuse the ACP Chat tab, seeded by source

Building/updating a miniapp is an **interactive Chat session**, not a one-shot endpoint. Pick
a source (session/skill/project) + genre → the miniapp dir is created and seeded (scaffold +
`sourceContext` brief) → an **ACP Chat session opens rooted in that miniapp dir** → the agent
writes/edits `<name>.html` while a **live sealed-iframe preview** (Plan-3 `Runner`, reusing
`Watch/sandboxDoc.ts`) updates → you refine by chatting → gate → commit (dual-write).

Reality from recon: `ChatManager.openChat({ cwd, brief, mcpServers })`
(`packages/run/src/chatSession.ts:69`) already takes `cwd` + `brief` as first-class params,
but the production wiring (`src/index.ts:304-319`) **forces a single shared `~/.agentgem/chat`
cwd** and the console `Chat` + `POST /api/chat` accept only `{agentId}`. So the studio needs
new wiring: a `studioId`/miniapp target on `POST /api/chat`, server-side resolved to a
**validated** path under `~/.agentgem/miniapps/<name>/` (mirror `workspaceName`/
`safePathSegment`), threaded as `cwd` into a new connectFn wrapper — preserving the current
"never trust a raw path from the request" invariant. The one-shot self-repair `generateGame`
loop is **dropped**: Chat drives generation interactively; the scaffold + brief only *seed*.

### Decomposition of the remaining work (each its own plan, off fresh `origin/main`)

- **Plan 2 — Miniapps registry + dual-write + gate** (bounded, temp-dir-testable): the
  `child_process` git wrapper, the `~/.agentgem/miniapps/` store (`<name>/<name>.html` +
  `meta.json`), dual-write to the workspace gem, gate-on-commit, and `save`/`list`/`publish`
  (git-push) routes. Keeps the genres / sealed scaffolds / `sourceContext` foundation.
- **Plan 2b — Chat studio wiring**: per-miniapp validated `cwd` + seed `brief` threaded
  through `POST /api/chat` → `ChatManager.openChat` → connectFn; console "open Chat in studio
  mode" targeting a miniapp; live preview.
- **Plan 3 — Play console surface**: Composer (source→genre→open studio), Arcade (grid of
  miniapps), permission chips + consent + brokers, publish/share UI.

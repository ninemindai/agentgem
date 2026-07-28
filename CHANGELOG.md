# Changelog

All notable changes to AgentGem are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

The npm core (`@ninemind/agentgem`) and the desktop app share a version number but
are tagged separately: core releases are tagged `v*`, desktop releases `desktop-v*`.

## [0.10.1] — `@ninemind/agentgem` (npm core) — 2026-07-28

Four commits behind 0.10.0, released the same day. The gemit report stops being a
dead end for the thing people want to do with it, a Nostr key can be linked without
a browser extension, and the console's 1150-test suite finally runs in CI.

### Added

- **`agentgem nostr link`** — link your Nostr npub to your account without a NIP-07
  browser extension. The host holds both the account-bound session (from
  `agentgem bind`) and the local Nostr secret, so it drives the same account
  endpoints and signs the challenge with the local nsec. Co-location removes the
  browser, not the consent: it is an explicit command, never a side-effect of
  provisioning.

### Changed

- **`agentgem gemit` opens the app's Gemit screen when the local app is running.**
  A `file://` report can never publish — signing needs the producer keypair, which
  a browser document cannot read — so all it can offer is a command to copy. When
  something answers on `127.0.0.1:$PORT/healthz`, the CLI opens `#/gemit` instead,
  where Publish and the share links actually work. The report file is still written
  and its path still printed, `--no-open` still opens nothing, and the chosen target
  is printed so it is never ambiguous. The app re-scores on arrival, because it
  cannot trust numbers posted by a browser.

### Fixed

- **`packages/console` is now gated by CI.** `pnpm test` runs the root config, which
  covers `dist/__tests__` only, so the console's 1153 tests ran in neither repo — a
  registry regression reached `main` through that gap and was caught days later by a
  downstream sync. Adding the suite first required fixing why it exited non-zero:
  jsdom has no `EventSource`, six panels open one, and the crash lands *after* the
  awaiting test passes, so every assertion was green while the run failed.

## [0.10.0] — `@ninemind/agentgem` (npm core) — 2026-07-28

The sharing release. `agentgem gemit` could already publish a card — it shipped in
0.9.0 — but a plain run never said so, ending at `Report: <path>`, so the publish
path read as if it did not exist. 14 commits make sharing a thing you can find,
finish, and understand: the CLI names the path, the report grows a share region,
the console grows a **Gemit screen** that scores and publishes without leaving the
app, and everything the report offers you to run is `npx`-prefixed — because the
reader of a report produced by `npx @ninemind/agentgem gemit` has no `agentgem`
binary on their PATH.

Alongside that, the quest log became genuinely clickable (it wasn't), what you
actually reach for is now on the card behind an explicit opt-in, and the identity
layer grew a second, separate keypair for the Nostr-facing surface.

### Added

- **The publish path has a name.** A scored `agentgem gemit` run now prints
  `Publish & share: npx -y @ninemind/agentgem gemit --share`, suppressed on the
  insufficient-data doorway and during `--share` itself.
- **LinkedIn and Facebook** alongside X. `gemitShareUrls` returns
  `{shareUrl, x, linkedin, facebook}`. Both new networks accept a URL and nothing
  else — they compose their preview from the `/games` OG card and drop any text —
  so the tier/score line still rides on X alone.
- **A share region in the report**: a copyable command before publishing, real
  intent links after. The CLI re-renders the local report post-publish so the file
  it opens carries live links rather than a stale call to action.
- **The X post carries the invocation**, not just the score — the reader most
  likely to act on it is the one who has installed nothing. Placed before the URL
  so the card still unfurls, and length-budgeted (X weights any link at 23 chars).
- **"What You Reach For"** — coding agents with session counts, most-used skills,
  and most-used subagents. `topSkills`/`topSubagents` were computed since the
  first gemit release but never rendered; `agents` is a new aggregate.
- **`--include-usage`** opts into shipping those names on the published card. The
  consent line moves *with* the flag rather than beside it — a widening that left
  the old promise on screen would be a false one.
- **A Gemit screen in the local console** (`#/gemit`): score the window, read the
  card in a sealed frame, publish it, and share it without leaving the app. A
  button inside the generated HTML is impossible — publishing signs the manifest
  with the local producer keypair, which a `file://` document can never read — so
  the affordance lives where a server already runs. Progress names the work
  ("Scoring 150 of 5,870 qualifying sessions") via a `/window` route that
  enumerates without scoring.
- **The card reports its height** to an embedding host using the MCP Apps
  `ui/notifications/size-changed` notification the miniapp client already emits,
  so a host that sizes miniapps sizes this card for free.
- **Nostr (secp256k1) identity** — `loadOrCreateNostrIdentity` alongside the
  ed25519 attestation identity: a BIP-340 Schnorr keypair with npub/nsec (NIP-19),
  NIP-01 event signing and verification. A **separate** key on a different curve;
  the two never interconvert. Same file hardening (0600, symlink-guarded,
  `O_NOFOLLOW`, race-safe), since the secret is a bearer credential.

### Changed

- **Every command the report offers is `npx`-prefixed**, single-sourced through
  one `GEMIT_CMD` constant shared by the report, the doorway and the CLI. The old
  `agentgem gemit --share` died with "command not found" for precisely the reader
  most likely to copy it.
- **The console's usage opt-in defaults on**, where the consent line sits directly
  beneath the checkbox and moves with it. The CLI keeps the opposite default:
  `--include-usage` stays an explicit opt-in because a terminal flag has no
  always-visible disclosure to pair with it.
- The published card is rendered **sealed** — no share affordance at all. The
  marketplace plays it in `sandbox="allow-scripts"` with neither `allow-popups`
  nor `allow-top-navigation`, so any link there is silently unclickable, and a
  dead button is worse than no button.

### Fixed

- **The quest log responds to clicks.** Ticking a quest was blocked and silently
  reverted unless "What if?" was already on, which read as broken rather than
  gated; it now enters the mode. And the tick was only reachable on a 528×24
  `<label>` inside a 562×129 row — roughly 81% of every quest was dead to clicks.
  The whole row now toggles, minus the copy button and command, which own theirs.
- **Gemit joins the console rail like its siblings** (`hiddenUntilUnlock`), which
  also stops a group leaking into the locked rail — that rail is foreground-only.

## [0.9.0] — `@ninemind/agentgem` (npm core) — 2026-07-27

The focus release: AgentGem is a **local-first developer tool**. `npx agentgem`
mines your coding-agent usage, distills reusable gems, materializes them to any
target, runs them locally, and shares them — peer-to-peer or through the
AgentGem marketplace (app.agentgem.ai). The hosted-service surface (accounts,
orgs/groups, hosted reviews, GitHub App), cloud deploy (Vercel / Cloudflare /
managed backends), and the GitHub-repo gem registry are no longer part of this
package — the marketplace client, `agentgem get`, publish-to-Explore,
share-cards, and send/receive are unchanged.

On top of that sweep, 193 commits land three more themes: the **chat surface
grows a spine** (durable ACP sessions that resume, a type-while-busy queue, and
a real Interrupt), **miniapps become authorable** (a shared house style, four
genres, file uploads, and MCP connectors the author picks in the Composer), and
**gemit gets its ceremonial card** — with the percentile claim held back until
the cohort is real.

### Added

- **Agent sessions survive.** `openExisting` resumes an ACP session through a
  capability-gated `session/resume` + `session/load`, falling back to a fresh
  session when the adapter cannot. Adapters report a capability snapshot at
  `initialize`, shut down through a stdin-end → `SIGTERM` → `SIGKILL` ladder, and
  surface a bounded stderr tail as startup-failure evidence.
- **Type while the agent is working.** Studio and the Chat tab queue messages
  during a turn and flush them in order; **Interrupt** cancels the live turn
  (`session/cancel`, `POST /api/chat/:id/cancel`) and streams surface the turn's
  `stopReason`. Turns POST the message in the body and attach the stream by
  `turnId`, so a dropped connection no longer loses the reply.
- **A shared house style.** `@agentgem/model` exports design tokens with
  per-surface theme adapters, adopted by the miniapp templates, the rubric
  report, the session dashboard, and gemit — so generated surfaces read as one
  system instead of four.
- **Four miniapp genres**: `skill-tuner` (skill readout with clipboard egress),
  `project-map` (analytical project readout), the retrofitted `session-heatmap`,
  and a Blank miniapp that can start as a **document** rather than a canvas game.
  A per-source template picker replaces the hardcoded session/genre fork, and a
  genre whose `sourceKind` disagrees with the seeded source is rejected.
- **Miniapp file uploads** — `POST /api/play/uploads` and `addUploadsToMiniapp`
  add files to an existing miniapp atomically, without a commit, under a
  cumulative ref cap.
- **MCP connectors for miniapps in the Composer** — a searchable
  `ConnectorPicker` (chips + combobox), a keyboarded `SourceList` with a
  recent/ranked shortlist and Show-all expand, an options band with tabs, and a
  Permissions disclosure. The `CapabilityStrip` shows declared `mcpNeeds` with
  their install state.
- **Repo Pulse** — a built-in, `mcpNeeds`-only demo miniapp, served from the
  arcade listing with its own MCP manifest.
- **gemit's ceremonial card** replaces the hero, backed by a serif dossier;
  Training Grounds collapses into the discipline bars. A cohort percentile gate
  keeps the standing claim **off until the cohort is real** — the card and the
  share text derive the top-N% figure from one transform, so they cannot drift.
- **ATIF drop-dir import health** — `scanAtifHealth` reports totals and grouped
  issues, `groupDiagnostics` folds diagnostics into display groups,
  `GET /api/watch/atif-health` serves them, and the console's Watch tab renders
  a panel that fails closed (amber) on a malformed or degraded payload.
- **The buzz persona-pack target** materializes a multi-persona team pack from
  subagents, with value MCP servers wired in.
- **`@agentgem/fabric`** (internal) — the in-process message fabric: addresses
  and trust zones, envelopes and scopes, a kind registry, stream-vs-feed channel
  declarations with bounded retention, a router (`handle`/`ask`/`send`), and
  in-memory feed channels. The chat turn engine and MCP tool calls now ride it;
  the security boundary stays in `PlayController`.
- **`@ninemind/miniapp-gate`** — the miniapp admission gate, extracted into its
  own package so the publishability check is one shared implementation.
- An opt-in few-shot report exemplar behind `AGENTGEM_REPORT_EXEMPLAR`
  (default off), hardened so the model cannot derive numbers from it.
- A `ROOT_UI_MOUNT` seam for serving a custom SPA at `/`.

### Changed

- `npx agentgem` boots the client app only; `start`/`dev` run `dist/client.js`.
- `POST /api/run` runs locally; non-local modes are rejected unless a dispatcher
  is provided by the embedding application. `GET /api/run-ready` returns
  `{ local }`.
- `GET /api/registry/gems` serves the marketplace index cache (plus an optional
  catalog source when one is bound by the embedding application).
- The console's Materialize panel gains **Run app** (render → install → build →
  start with live log tail); Get-more focuses on marketplace installs and `.gem`
  import.
- The server library is extracted into `@agentgem/app`, and the shared spine is
  bundled into `GemCoreComponent`; hosted-capability binding keys move to
  `@agentgem/contract/bindings`.
- ACP runner, chat, and the recommender share one turn façade (`promptRun` /
  `turnEvents`); the update reducer moves from `run` to `base`. Errors go through
  `normalizeAcpError` for uniform retryable/kind classification, and a turn that
  times out **after its reply already streamed** is salvaged rather than lost.
- The website leads local-first — new hero and cards, a community marketplace
  section, an OSS + Enterprise editions page, and an Enterprise nav tab.
- Studio's Interrupt sits beside Attach files in the composer.

### Fixed

- **Built-in miniapps are read-only** — chat, save, and uploads are guarded and
  Studio opens read-only, so a shipped demo cannot be edited out from under the
  arcade.
- **The load smoke can no longer crash the server.** It runs in a worker thread
  with `Path2D` stubs and async-escape containment, and never rejects.
- `saveMiniapp` preserves server-owned `meta.uploads` (kept out of the gem), and
  the miniapp is checkpointed *before* the done frame is emitted.
- The consent card is a focused dialog whose Allow arms after 500ms.
- Studio's queued flush reuses the live chat session — `chatIdRef` beats a stale
  closure — and the stream attach loop detaches on client disconnect.
- gemit: the dossier `h2` wraps instead of overflowing at narrow widths, the
  crown stacks below 700px, opacity no longer washes out dossier chrome, the
  discipline sliders get an accessible mode, what-if mutations are gated to
  measured mode, and card animations honour reduce-motion.
- The gemit skill's frontmatter is valid YAML — a colon in the description had
  hidden it from skills.sh.
- Marketplace: account-link recovery routes to the profile hub's Account tab, and
  sign-out clears the page and names the provider in the collision banner.

### Removed

- Cloud deploy: the Deploy console panel, `/api/publish*`, `/api/undeploy`,
  `/api/deploy-*`, `/api/credential`, `/api/agentcore/*`, and the
  Vercel/Cloudflare deploy engines in `@agentgem/run`.
- The GitHub-repo gem registry: `/api/registry/{ready,index,search,resolve,install,publish}`,
  the registry MCP tools, the console Publish panel, `AGENTGEM_REGISTRY_REPO`/`_REF`,
  and the registry engine in `@agentgem/distribute` (`registryTypes` remains).
- The hosted service: aggregator/auth/accounts/orgs/groups/stars/hosted-reviews/
  GitHub App/OG-card modules, the server entry, and the scheduled source-indexer
  workflow.
- Unused dependencies: `@aws-sdk/client-bedrock-agentcore-control`, `vercel`,
  `@electric-sql/pglite`, `pg`, `drizzle-orm`, `drizzle-zod`, `@agentback/drizzle`,
  `@anthropic-ai/sdk`.
- The broken public Fly Deploy CI workflow.

## [desktop-v0.10.1] — desktop app — 2026-07-28

No desktop-specific changes. Worth noting for desktop users specifically: because
the desktop app *is* a running local console, `agentgem gemit` in a terminal now
lands on its Gemit screen — with Publish and live share links — rather than on a
static file.

Embeds everything in core 0.10.1.

## [desktop-v0.10.0] — desktop app — 2026-07-28

No desktop-specific changes this cycle. The app gains the release's console work
by embedding it: the **Gemit screen** (`#/gemit`) — score your last 30 days, read
the card, publish it, and share it to X / LinkedIn / Facebook without leaving the
app — plus the console rail fix that keeps Gemit hidden until the console unlocks.

Embeds everything in core 0.10.0.

## [desktop-v0.9.0] — desktop app — 2026-07-27

No desktop-specific changes this cycle — the shell, auto-update feed, and
code-signing pipeline are unchanged from `desktop-v0.8.0`.

This release embeds everything in core 0.9.0: the local-first sweep, resumable
ACP sessions with a type-while-busy queue and Interrupt, the shared miniapp house
style with four genres and file uploads, MCP connectors in the Composer, gemit's
ceremonial card, and the ATIF drop-dir health panel.

## [0.8.0] — `@ninemind/agentgem` (npm core) — 2026-07-19

A release about knowing — and showing — how well you steer. **gemit** ships end to
end: one command scores your last 30 days of agent sessions into an interactive
character-sheet report, `--share` publishes it as an unlisted card, and the
marketplace page around a shared card invites the next person to score themselves.
Around it: a redesigned first-run and Mine experience, needs-your-input alerts in
Watch, live-updating miniapp MCP tools, file-seeded miniapps, and "Sign in with X".
169 commits since 0.7.0.

### Added

- **`agentgem gemit`** — score your last 30 days of local coding-agent sessions
  (context discipline · process quality · setup maturity, deterministic detectors,
  no LLM) into a self-contained HTML report: tier + rank with a count-up reveal,
  perk unlocks with honest progress meters, and a **Training Grounds** what-if
  simulator — drag the projected bars or take on **Quest Log** actions (concrete
  remedies derived from your own fired findings) and watch the projected tier
  recompute live, confetti included. The measured score never moves; exact effect
  chips only where the payload fully determines them.
- **`agentgem gemit --share`** — publish the report as an **unlisted** card on
  app.agentgem.ai (visible only via its link). The shared copy strips skill and
  subagent names; a pre-publish summary shows exactly what ships (`--yes` to skip
  the prompt), and the CLI prints the card URL plus a prefilled X share link.
  Same-day re-shares update the card in place; a new day mints a new card.
- **Marketplace invite chrome for steering cards** — a shared gemit card's page
  renders the report inline with "What's your steering level?" and a copyable
  one-liner, so a card is also an invitation.
- **`/gemit` skill** (`skills/gemit/SKILL.md`) — a deliberately thin skill: run
  the CLI, relay the tier, offer the share. All scoring stays in the CLI.
- **First-run reveal + progressive disclosure.** The console opens on a
  consent-gated streaming reveal of your top workflow, builds it into a gem on
  accept, and unlocks the full navigation rail in disclosure groups as you go;
  returning users get a migration ceremony instead of a cold wall of pages.
- **Mine, redesigned.** Real gem cards with per-card actions and reserved score
  slots, a Value/Type/Maturity group-by switcher, a live rubric layer that fills
  scores in as they compute, and inline viewers for Distill results and rubric
  reports.
- **Watch: needs-your-input alerts.** Sessions blocked on a permission prompt or
  question raise toasts and per-session bell badges, with cached session discovery
  so the attention poll stays cheap.
- **Live miniapp MCP tools.** `agentgemApp.mcp.watchTool` gives miniapps
  polling-based live tool results with coalesced polls, single-flight epochs, and
  an `mcp/invalidate` signal that re-polls live watches without resurrecting
  stopped ones.
- **File-seeded miniapps.** The Studio composer takes file uploads for Blank/HTML
  creation with a Ship→`uploads/` vs Reference→gitignored `ref/` toggle.
- **Sign in with X** (optional social provider) and **Tier-1 handle-only account
  merge**.
- **`@agentgem/contract`** — a new pure package carrying catalog types and signing
  payloads, part of a wider seam pass (console page seams, CLI subcommand seam,
  server mount hooks) that keeps the OSS core cleanly separable.

### Changed

- The console rail is journey-arc grouped (Observe/Build/Evaluate/Share) with Mine
  promoted to the foreground.
- `agentgem` with no subcommand now starts the pure-client entry.
- Rubric hygiene scores stream into Mine cards stale-while-revalidate instead of
  blocking the first paint.

### Fixed

- Studio resume shows live progress and can no longer lock the chat (busy-guarded
  submit, tolerant `/state` errors, reconcile-before-unlock).
- Miniapp MCP reconnect defers closing the old transport until in-flight calls
  drain.
- Home state self-heals a corrupt `home-state.json`; first-run detection can't be
  tainted by the warm boot pass.
- Upload MIME types are sanitized before entering `data:` URIs; reference uploads
  are never git-tracked.

## [desktop-v0.8.0] — desktop app — 2026-07-19

### Added

- **About dialog checks for updates** on demand; offline check failures stay
  silent instead of alarming.

Embeds everything in core 0.8.0 above — including gemit, the first-run reveal, the
redesigned Mine, and the Studio resume + Distill PATH fixes that predated this
build.

## [0.7.0] — `@ninemind/agentgem` (npm core) — 2026-07-15

A release about closing loops: session inspection grows analytical lenses whose
findings feed back into the gem loop, a two-way memory bridge syncs curated
learnings with hosted AI-memory providers, recall ranking learns from proven
outcomes, and org admins get a governed view of their own benchmark. Background
agent tasks pick their agent and model per task family. 110 commits since 0.6.0.

### Added

- **Memory-provider sync bridge.** A new `@agentgem/memory` package syncs curated
  memories two ways with hosted AI-memory providers — **mem0** and **supermemory**
  adapters ship first. Pulls land in the recall index behind a per-provider cursor;
  pushes go through a consent-gated curation outbox with scrub + dedupe, per-candidate
  bookkeeping so a mid-batch failure can't double-write, and a (provider,key) re-push
  guard. A console **Memory panel** manages providers and the outbox; secrets live in
  a 0600 config file, and the routes are local-only (never hosted).
- **Inspect lenses on finished sessions.** A generated-and-cached **Dashboard lens**
  with a long-form editorial **Report mode** whose recommended actions feed the gem
  loop; a **Blast-radius map** — a replayable touch map of files, skills, and tools —
  inside the Map⇄Transcript structure toggle; a **Context lens** with a richer context
  chart, context spikes that deep-link to the verbatim transcript turn, a full-screen
  structure panel, and Codex session support across the new lenses.
- **Background agent tasks settings.** Reports, distillation, recommendations, and
  judging default to a fast model and now resolve their agent + model from per-task-
  family preferences — editable in a new Settings section backed by
  `/api/agent-tasks`.
- **Proven-use recall ranking.** Insights' judge pass persists per-session outcomes
  into an artifact-outcomes store; recall applies a Wilson-shrunk outcome score as a
  per-session-outcome boost, validated by an A/B route and an offline judge-agreement
  probe.
- **Org benchmark view + governance.** Org admins get a Benchmark tab on the
  `/orgs/:scope` hub (org-scoped, no k-floor) with member breakdowns, plus a
  Governance section: a `contributeAllowed` forbid that rejects ingest from members
  and a flag controlling the benchmark view.
- **EMBER, a built-in Arcade miniapp.** A live context-hygiene gauge over the watched
  session, driven by a brokered context-hygiene stream into sealed miniapps, with a
  consent-gated `copy-command` capability that copies `/compact` to the clipboard
  (never remembered).
- **Rubric quality-of-life.** Agent-rendered HTML reports from rubric evaluations,
  one-click hygiene shortcuts on Sessions rows and the Mine scope, a scope-adaptive
  session picker for session-granular rubrics, and live progress on report render.

### Changed

- **The live Dashboard tab in Watch retires** in favor of the Inspect Dashboard lens.
- Notify + report controls move off the wordmark; the session picker rebinds the
  context-hygiene stream on switch.
- Docs: architecture diagrams gain the hosted band and a memory-sync diagram; the
  website adds a Marketplace section and Memory card; guides cover memory sync,
  proven-use recall, publish scopes, and PWA installs.

### Fixed

- Background insight agents resolve the ACP adapter launch (PATH → managed → bundled)
  before spawning, and report/distill timeouts accommodate slower default models.
- The `/api/benchmark` proxy mounts in server mode too, `contextCap` recognizes
  1M-default model families, and a memory-provider save with a blank key can no
  longer clobber the stored key.
- The end-side split handle parks in the grid gap instead of over rail text, and a
  rubric session pin no longer fights reattach.

## [desktop-v0.7.0] — desktop app — 2026-07-15

### Changed

- Notifications are on by default in the desktop app, and **Check for Updates** gives
  visible feedback.
- Everything in npm core 0.7.0 above, since the desktop app embeds the same console
  and server: Inspect lenses, the memory bridge, per-family agent tasks, EMBER, and
  proven-use recall.

## [0.6.0] — `@ninemind/agentgem` (npm core) — 2026-07-13

A follow-up release focused on the benchmark data loop, report durability, and
richer share cards. A local core can now contribute anonymized attestations to the
hosted benchmark (opt-in), long-running reports survive navigation, mini-app share
cards carry a real screenshot, and Insights folds into the Mine tab. Most of the
per-feature SSE endpoints move onto agentback `streamOf` routes. 84 commits since
0.5.0.

### Added

- **Contribute to the hosted benchmark from a local core.** A consent toggle in the
  Benchmark tab (off by default) opts a producer into posting *ingredients-only*
  attestations over its published gems to the hosted aggregator, plus a **Contribute
  now** action and a cache-aware `contribute` warmable. A signed `POST /my-gems`
  lists the producer's owned gems (deduped by gem key so multi-version gems attest
  once), and interactive publish ingests only when the toggle is on.
- **Reports survive navigation.** An in-memory `ReportRegistry` and a `useReportRun`
  hook let Insights, Curate, and Rubric evaluation reattach to a running report after
  you leave and return to the tab, guarding against duplicate runs and unmount races.
  A report-done notification and an activity menu surface finished runs.
- **Mini-app share cards carry a real screenshot.** Publishing a game in Studio
  captures a screenshot from the sealed preview (via a capture shim and a
  capture-confirm step), stores it in a new `gem_covers` table, and composites it into
  a screenshot-hero variant of `/og/card.png`.
- **Live Dreaming progress in the Journey scene.** The warm pass publishes incremental
  step progress (LIGHT / DEEP / REM and the current project) to `/api/dream/status`,
  rendered as a live step tracker, with the current phase shown on the warming pill.
- **Per-gem dates and version on catalog grids**, and a Request-review modal with a
  folded-in GitHub connect step.

### Changed

- **Per-feature SSE endpoints move onto agentback `streamOf` routes.** Insights,
  workflow analysis, rubric evaluation, scorecard scan, and gem run + verify all
  migrate off raw-Express SSE onto native agentback streaming routes sharing a common
  pump.
- **Insights folds into the Mine tab** as a second view (Workflows + Outcomes) behind a
  shared project dropdown, with a `cacheOnly` peek on the insights route.
- **The desktop app runs as a pure API client.** A `src/client.ts` entry ships common
  plus a benchmark proxy with no bundled aggregator, reading the hosted benchmark
  read-only (and degrading to an empty list when anonymous).

### Fixed

- Benchmark digest failures surface as per-gem `failed` instead of posting an empty
  digest, and `postAttestation` stays opt-in with the hosted endpoint passed
  explicitly.
- Public browse shows the *latest* gem version rather than the oldest.
- A finished report run is no longer re-registered on reattach, and a Rubrics reattach
  is no longer clobbered by the default-select race.
- The `shareOriginSecret`-before-`originGuard` registration order is preserved.

## [desktop-v0.6.0] — desktop app — 2026-07-13

### Changed

- **The desktop host runs as a pure API client** — no bundled aggregator or PGlite; it
  reads the hosted benchmark through a proxy.
- Everything in npm core 0.6.0 above, since the desktop app embeds the same console and
  server: benchmark contribution, durable reports, screenshot share cards, live
  Dreaming progress, and the Insights-into-Mine merge.

## [0.5.0] — `@ninemind/agentgem` (npm core) — 2026-07-12

A large release. Identity moved onto [better-auth](https://better-auth.com), gems
gained a review-gated publishing path with group sharing and visibility scopes,
mini-apps became installable PWAs that play offline, and every shareable link now
unfurls a branded card. 488 commits since 0.4.1.

### Added

- **Sign in with a passkey.** WebAuthn is now a first-class credential alongside
  GitHub and Google: register a passkey from Account settings, then sign in with a
  single button that opens a provider dialog. Passkeys are a separate better-auth
  plugin, and the marketplace RP ID is derived from the cookie domain.
- **A tabbed profile hub at `/@handle`.** `/account` and `/groups` are absorbed into
  one hub with **Apps / Reviews / Orgs / Groups / Account** tabs. Owner-only tabs stay
  hidden from visitors, and each panel fetches the viewer's own data — no cross-account
  leak.
- **Publish a gem as Public, Unlisted, or Private.** The publish flow carries a
  visibility scope through to the catalog row: Explore lists only public gems, an
  anonymous resolve 404s a private gem, and a private gem gets its own owner-only detail
  page (download, play, unpublish).
- **Gem versioning with an overwrite-vs-new-version choice.** Publishing an existing key
  runs a signed pre-flight (`/api/publish-status`) and asks whether to overwrite the
  current version or cut a new one.
- **Review-gated publishing.** An author requests review from a group; members get a
  Reviews inbox (list / detail / approve / request-changes / comment / withdraw), can
  install a staged gem to test it — including playing a staged game in a sealed modal —
  and an approval atomically publishes. An unread badge polls the Reviews nav item.
- **Groups, and gems shared with a group.** Create or join a group by token, manage
  members and invites, and share a *private* gem with a group as an additive ACL
  (`gem_group_shares`) gated by a single `accountCanAccessGem` check. Leaving a group
  withdraws your open review requests and drops your shares.
- **Rubrics are a first-class gem type.** A rubric is now a `RubricArtifact` you can
  bundle into a gem from the Curate surface; it installs alongside the gem's other
  artifacts, carried end-to-end through the archive, the wire schemas, and all three
  install handlers.
- **Installable PWAs that play offline.** The marketplace and console ship a web-app
  manifest with real gem-mark icons; a service worker precaches the shell and caches
  game html (pinned-first, then a recently-played LRU). A **Download for offline** toggle
  pins a game, and an `/offline` library plays your pinned games with no network.
- **Search and filter the mini-apps gallery.** A search box plus genre and tag chips
  filter the arcade; free-form tags can be set from the Studio publish toolbar.
- **Branded link-preview cards for every shareable entity.** Games, gems, `@handle`
  profiles, and skills now unfurl a branded `summary_large_image` card, rasterized from
  SVG by a portable resvg-wasm renderer with an embedded font — no system fonts and no
  Cloudflare primitive required.
- **Durable Studio sessions and a Stop control.** A Studio chat session survives reload
  and restores from its transcript, reconciling liveness; the ACP session id names the
  transcript file.
- **A built-in Protocol Inspector mini-app**, plus a conformant client shim (v2) that
  speaks spec-shaped `ui/initialize` and unwraps `CallToolResult`, bringing Play
  mini-apps in line with MCP Apps / mcp-ui.
- **Reflection intake in the Dreaming panel.** Repeated tool errors and rejections
  (recurrence ≥ 2) are detected and drafted as guardrails you can review and apply to
  `CLAUDE.md` / `AGENTS.md` through a hash-guarded managed-region writer.
- **A resizable, collapsible console.** The Shell sidebar collapses to an icon rail and
  resizes by drag or keyboard; Studio gets a draggable preview↔chat split and a
  full-width page.

### Changed

- **Identity runs on better-auth.** The hand-rolled OAuth stack is deleted in an atomic
  migration: an account is keyed on a uuid with an optional handle (the one display
  name), gem ownership is `accounts.id` (an unresolved row is owned by nobody), and
  Google joins GitHub as a social provider. Accounts can link additional providers and
  absorb a fresh account (the Flow A / Flow B connect flows).
- **Shareable entity paths.** A game resolves by a canonical, copyable `/games/:key` URL
  that also unfurls; a bare share key resolves to its latest version.
- **Inventory reads defer artifact bodies.** `/api/inventory?body=defer` returns metadata
  only, with bodies loaded on demand via `/api/artifact/content` — cutting a
  multi-megabyte read to kilobytes.
- **The transcript index stores raw usage.** Index schema v2 records raw token counts and
  resolves them against the current inventory at query time.
- **Mini-app capabilities are split and reconciled.** `GameCapability` splits into
  `ToolCapability | ActionCapability`; a mini-app's needs are derived from its html and
  reconciled against the declaration at save, pruning undeclared calls.

### Fixed

- **The marketplace sign-in and passkey surfaces are styled.** A Modal no longer steals
  focus on every keystroke, and the passkey + sign-in UI carries hand-authored CSS rules
  instead of rendering browser defaults.
- Numerous aggregator, auth, console, and play fixes land across the 488-commit range;
  see the git history for the full list.

## [desktop-v0.5.0] — desktop app — 2026-07-12

### Added

- **Right-click Cut / Copy / Paste.** The desktop host now has a native editing context
  menu.

### Changed

- Everything in npm core 0.5.0 above, since the desktop app embeds the same console and
  server: better-auth identity, review-gated publishing, groups and sharing, rubric
  gems, installable/offline mini-apps, branded link cards, and the resizable console.

## [0.4.1] — `@ninemind/agentgem` (npm core) — 2026-07-09

### Fixed

- **The Studio preview no longer renders a stale mini-app.** The Play registry reads
  serve mutable on-disk state — the Studio agent rewrites the mini-app's html between
  requests — but they answered with a bare `ETag` and no `Cache-Control`. That let the
  browser apply heuristic freshness and serve a cached body without revalidating, so
  the preview could show html the agent had already replaced, with nothing to indicate
  it was stale. The four mutable reads are now marked `no-cache` (revalidate, not
  `no-store`), so a repeat mount costs a conditional request and still answers `304`.
- **Studio fullscreen now covers the chat and composer.** The preview stage animated
  with `fill-mode: both`, leaving the opacity animation permanently in effect — and an
  in-effect opacity animation is a permanent stacking context, which pinned the
  fullscreen overlay inside the preview column while the chat panel painted over it.
- **A failed Studio preview now says so.** Studio swallowed every load error and
  handed an empty string to the iframe, which reads as a working preview of an empty
  app rather than as a failure. It now renders a distinct loading, failed (with the
  server's reason and a **Retry**), or loaded state, and a refresh that fails after a
  build keeps the last good preview on screen. This does not fix the intermittent
  blank preview, whose root cause is still unknown — it makes the next occurrence
  name the failing layer instead of leaving a white rectangle.

### Changed

- **Documentation covers the 0.4.0 feature set.** New `docs/play.md`,
  `docs/recall.md`, and `docs/sharing.md`, refreshed console screenshots, and a
  website rewritten around the shipped console.

## [desktop-v0.4.1] — desktop app — 2026-07-09

### Added

- **A real app icon.** The icon was a blank dark square placeholder, which fed both
  the packaged app icon and the system tray. It is now the AgentGem gem on a warm-dark
  rounded tile, with `build/icon.svg` checked in as the vector source. This missed the
  `desktop-v0.4.0` tag by one commit, so 0.4.0 installers shipped with the placeholder.

### Fixed

- Everything in npm core 0.4.1 above, since the desktop app embeds the same console
  and server: the stale Studio preview, the fullscreen overlay, and the silent
  preview failure.

## [0.4.0] — `@ninemind/agentgem` (npm core) — 2026-07-09

### Added

- **A rebuilt console.** The local UI is now a React single-page app with
  phase-primary navigation — a top-level **Observe** vs **Build** switch, grouped
  artifact panels, and hash routing — replacing the single static HTML page that
  shipped through 0.3.1. Everything below lives in this new console.
- **Cross-session transcript recall, and a Goldmine MCP server.** A **Recall**
  screen searches across your past Claude sessions and surfaces "moment" cards you
  can deep-link into, chat about, or extract. The same intelligence is exposed as a
  new `agentgem-goldmine` MCP server (`search_sessions`, `search_session_content`,
  `summarize_session`, `ask_session`, `get_artifact_detail`,
  `get_behavior_findings`) so any coding agent can query your session history.
- **Chat with a local coding agent in the console.** A **Chat** tab drives a local
  ACP agent (Claude, Codex) from inside the app, with your session transcripts
  available to it as tools.
- **Session timeline and transcript viewer.** The **History → Session** view renders
  an SVG context timeline — a context-hygiene rail plus skill and subagent markers —
  alongside the raw transcript, with a Map⇄Transcript toggle.
- **Context-hygiene detection.** AgentGem now detects context bloat in a session
  using cheap, LLM-free detectors and a bloat curve, produces a report and a
  deterministic "cut here at turn N" boundary, and ranks sessions on a leaderboard.
  `agentgem warm --watch --nudge` raises an ambient OS notification when a live
  session's context gets heavy.
- **`agentgem warm` — a background precompute daemon.** `agentgem warm --watch`
  keeps insight and scorecard caches warm as your `.claude` files change, and
  `--install-service` / `--uninstall-service` manage a launchd or systemd unit so
  the daemon starts at login.
- **Play mini-games.** AI-generated mini-games are now first-class `game` Gems, with
  an Arcade to browse and play them, a Composer and Studio to build one by chatting,
  and a git-backed `~/.agentgem/miniapps/` registry that versions each one.
- **Share and install a Gem without a registry.** `agentgem get <key>[@version]`
  downloads a published Gem and imports it locally with zero config. `agentgem send
  <file.gem>` encrypts and stashes a Gem over NATS store-and-forward and prints a
  one-time ticket that `agentgem receive <ticket>` fetches, decrypts, and verifies.
  The marketplace's "Open in AgentGem" button deep-links into the console over the
  new `agentgem://` protocol.
- **GitHub identity, from the CLI or the console.** `agentgem bind` binds this
  machine's signing key to your GitHub account over device flow, establishing an
  anti-sybil identity for publishing and sharing. The console carries the same
  identity: a chip in the shell footer shows whether you are signed in and opens a
  sign-in modal in place, and publishing a mini-game from **Studio** when you are
  signed out connects you inline and then resumes the publish you started.
- **Curated sources become local skills.** `agentgem sources install <source> <path>`
  installs a curated persona as a local skill, and `agentgem index-sources` indexes
  curated sources' skills and GitHub stars behind the "Popular Skills" board.
- **Distill skills into a review queue.** `agentgem learn` distills your latest
  session into a **Dreaming** review queue you can accept from in the console. The
  new `agentgem-distill` MCP server exposes the same pipeline (`scan_workflow`,
  `inspect_ingredients`, `build_attestation`, `sign_and_publish`).
- **`agentgem verify` — cross-agent compatibility.** Run a Gem's contract across your
  local agent roster (`--agents claude,codex`, `--fetch`) and print the resulting
  compatibility matrix.
- **Installable shared setups.** Preview a shared setup and install it into your
  config with one consent-gated click, from the new **Setup** screen.
- **Local usage rollups.** `agentgem usage report [--backfill]` pushes daily usage
  rollups from your machine so team and org usage views can attribute activity per
  repo owner. The warm daemon also does this on a schedule.
- **Global vs project scope on Optimize and Setup.** A Global/Project switch lets
  you disable and re-enable skills in a specific project's own `.claude/` as well as
  your global config. The inventory merges both layers with a badge showing where
  each artifact lives, usage is scoped to the project's own transcripts, and a
  guard lets a request only touch the layer it owns.
- **Gems can carry a loop (automation) facet.** A Gem may now hold an optional
  top-level `loop` facet describing a recurring task; publish, install, and the
  `.gem` archive all round-trip it so the facet survives sharing intact.
- **The Play agent picker surfaces agents from your transcripts.** Alongside the
  runnable roster, the picker now lists the coding agents it discovers in your
  session history and labels them, so you can pick the one you actually use.
- **Chat can start in a specific project.** A "Start in" launcher (sharing the same
  Global/Project picker) points a Chat session at a project directory, and the
  server validates the requested working directory against an allow-list before the
  agent connects there.

### Changed

- **The published package is now self-contained.** The private `@agentgem/*`
  workspace packages are bundled into each entrypoint at publish time, so
  `npx @ninemind/agentgem` and a global install resolve with no extra setup.
- **Two new bundled executables.** Installing the package now also puts
  `agentgem-distill` and `agentgem-goldmine` on your `PATH` alongside `agentgem`.

## [desktop-v0.4.0] — desktop app — 2026-07-09

### Added

- **"Open in AgentGem" web links now reach the installed app.** The app registers an
  `agentgem://` URL scheme with the OS, so the marketplace's "Open in AgentGem"
  button launches or focuses the app and jumps to the Get Gems tab — regardless of
  the random local port the packaged app binds. The link carries the pre-filled
  search query and, for an installable gem, the install key and version, so the gem
  installs with no extra steps.
- **Native OS notifications from the embedded console.** A payload-validated IPC
  bridge lets the console raise a real system notification through the main process,
  with no permission prompt or HTTPS origin needed. Clicking the notification
  surfaces the app window.
- **ACP coding-agent adapters ship inside the app.** The Claude Code and Codex ACP
  adapters are bundled into the app's resources, so Chat and Gem runs work on
  desktop without a separate `npm install` or a global adapter on your `PATH`.
- **The embedded console gained Recall, `.gem` import, and Play mini-games.** Search
  across past Claude sessions and hand a moment off to Chat or Extract; download a
  self-contained `.gem` from the marketplace and import it locally; browse, play,
  and remix AI-generated mini-games.

### Changed

- **macOS builds are signed and notarized.** The release pipeline signs the app with
  a Developer ID certificate and notarizes it with Apple, so Gatekeeper opens the
  `.dmg` and `.zip` normally — the "AgentGem is damaged and can't be opened" message
  from the unsigned 0.1.1 builds is gone. Windows and Linux builds remain unsigned,
  so Windows SmartScreen may still warn.
- **Upgraded to Electron 43 (Node 24).** The embedded server now runs on Node 24's
  built-in `node:sqlite`, so the Cursor session scan runs inside the desktop app
  instead of quietly returning nothing.

### Fixed

- **GitHub sign-in completes.** OAuth and device-flow verification pages now open in
  your system default browser rather than an in-app window, where Google sign-in and
  passkeys do not work. The device-flow screen also grew a Copy button for the user
  code.
- **Inspect no longer appears to re-scan `~/.claude` on every visit.** The
  session-scan cache lifetime went from 15 seconds to 5 minutes. The manual Refresh
  button still forces a fresh scan.

### Upgrading

- Because 0.1.1 shipped unsigned and this build is signed, macOS auto-update
  (Squirrel.Mac) will not apply this update over an installed 0.1.1. Download this
  release once by hand; auto-update works normally from here on.

## [0.3.1] — `@ninemind/agentgem` (npm core) — 2026-06-26

### Fixed

- **Workflow analysis no longer reads as a hang.** The first analysis of a project
  runs the live ACP agent, which could sit silent for 30–60s before its first
  token. The **Analyze** view now ticks an elapsed-seconds counter onto the active
  phase during that wait, switches to "drafting…" and reveals the live token stream
  on the first delta, and always clears the timer on teardown.
- **Bounded the whole ACP run, not just the prompt.** `recommendWorkflow` and
  `distillWorkflow` now bound every step — connect, session open, `setMode`, and
  prompt — against one shared deadline. The ACP `initialize` handshake and session
  start were previously unbounded, so a stalled adapter or auth wait could hang past
  the prompt-only timeout instead of degrading to the deterministic fallback.

## [0.3.0] — `@ninemind/agentgem` (npm core) — 2026-06-26

### Added

- **Run & verify a Gem with a local coding agent.** Test-run the live Gem before you
  ship it: drive a local ACP coding agent to execute and verify the Gem, with a
  streaming **Run** preview mode in the UI (`prepare` → SSE with an opaque `runId`).
  ACP adapters are resolved from local deps with a global → cache → fetch fallback —
  no global install required. See [docs/testbed-and-run.md](docs/testbed-and-run.md).
- **Sandboxed Gem runs.** Gem runs can execute inside an OS-native sandbox (macOS
  Seatbelt, Linux `bwrap`) that confines writes to the run directory, so agent
  **auto-allow is safe by default** on the isolated path. A `SandboxBackend` registry
  auto-selects the backend, and the run sandbox (`{backend, isolated}`) is exposed on
  the REST/SSE surface. See the sandboxed-Gem-run design under
  [docs/superpowers](docs/superpowers).
- **Skill distillation from transcripts.** Distill reusable **SKILLs** out of a
  project's session transcripts: a field-aware default-deny scrubber, n-gram recurrence
  detection over builtin procedures, candidate distillation with validation, review in
  the UI, and one-click **accept** to fold an accepted draft into the built Gem. See
  [docs/analyze.md](docs/analyze.md).
- **Channel artifact.** A neutral `channel` artifact type with a named platform
  registry: declare channels on a Gem (`POST /api/gem`), aggregate their secrets at
  build time, and dispatch to a platform renderer (Eve channel renderer ships; other
  platforms skip with a reason). A **Channels** picker is available in the gem-build
  stage. See the channel-artifact spec under [docs/superpowers](docs/superpowers).
- **Registry-optional Gem share & discovery.** Export and install a single self-contained
  `.gem` without a registry, plus registry **discovery/search**, MCP share tools, and a
  **Get-gems** UI. See [docs/registry.md](docs/registry.md).
- **Blog.** Added a project blog, including "Building AgentGem with Claude Code".

### Changed

- Generated deploy targets now pin **AI SDK v7 (GA)**.
- Outward-facing POST endpoints reject confined/invalid input with a **400 and a reason**
  instead of an opaque 500. See [docs/input-containment.md](docs/input-containment.md).

### Security

- **CSRF guard** on state-changing endpoints, **server-derived run directory**, and
  opt-in agent auto-allow.
- Pinned Gem-URL fetches to a **validated IP** to close a DNS-rebinding SSRF.
- Audited outward-facing POST **input containment**.

## [0.2.0] — `@ninemind/agentgem` (npm core) — 2026-06-24

### Added

- **A2A target.** Export any Gem as an [A2A](https://a2a-protocol.org/) target: an
  **Agent Card** (`agent-card.json`, protocol 0.3.0) for discovery, or — opt-in — a
  runnable **A2A server** (AI SDK v7) that serves the Card and executes the agent over
  JSON-RPC and REST, with streaming task lifecycle, push notifications, and optional
  `A2A_API_KEY` bearer auth. See [docs/a2a.md](docs/a2a.md).
- **Analyze — workflow-aware Gem recommendation.** Scan a project's Claude session
  transcripts to see which skills, MCP servers, and hooks you actually used, and get
  candidate Gems clustered by recurring workflow. Powered by a local Claude agent over
  ACP with a deterministic fallback (never fails), one-click **Switch & apply**, and
  per-project caching with re-analyze. `GET /api/workflow/analyze/stream` (SSE) and
  `POST /api/workflow/analyze`. See [docs/analyze.md](docs/analyze.md).

## [desktop-v0.1.1] — desktop app — 2026-06-24

### Added

- **Native desktop app** (macOS, Windows, Linux). An Electron host that runs the
  AgentGem server in its own window — native folder picker, app menu, system tray,
  and scaffolded auto-update — with no terminal or `localhost` URL to manage. The
  core is bundled into a self-contained file so the packaged app is the same server,
  hosted, not a fork. Builds are currently unsigned. See [docs/desktop.md](docs/desktop.md).

## [0.1.1] — `@ninemind/agentgem` (npm core)

- Initial public release: secret-safe Gem capture, the manifest + lock archive,
  composition, the GitHub-backed registry, deploy targets (Eve, Flue, OpenAI Sandbox,
  Bedrock AgentCore, Claude Managed Agents), and the MCP-native path. Published to npm
  as [`@ninemind/agentgem`](https://www.npmjs.com/package/@ninemind/agentgem).

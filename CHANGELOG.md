# Changelog

All notable changes to AgentGem are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

The npm core (`@ninemind/agentgem`) and the desktop app share a version number but
are tagged separately: core releases are tagged `v*`, desktop releases `desktop-v*`.

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

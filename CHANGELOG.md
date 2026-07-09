# Changelog

All notable changes to AgentGem are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

The npm core (`@ninemind/agentgem`) and the desktop app share a version number but
are tagged separately: core releases are tagged `v*`, desktop releases `desktop-v*`.

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

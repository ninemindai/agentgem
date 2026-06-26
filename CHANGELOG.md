# Changelog

All notable changes to AgentGem are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

The npm core (`@ninemind/agentgem`) and the desktop app are versioned separately:
core releases are tagged `v*`, desktop releases `desktop-v*`.

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

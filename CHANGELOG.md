# Changelog

All notable changes to AgentGem are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

The npm core (`@ninemind/agentgem`) and the desktop app are versioned separately:
core releases are tagged `v*`, desktop releases `desktop-v*`.

## [Unreleased]

### Added

- **Native desktop app** (macOS, Windows, Linux). An Electron host that runs the
  AgentGem server in its own window — native folder picker, app menu, system tray,
  and scaffolded auto-update — with no terminal or `localhost` URL to manage. The
  core is bundled into a self-contained file so the packaged app is the same server,
  hosted, not a fork. Builds are currently unsigned. Will ship as `desktop-v0.1.1`.
  See [docs/desktop.md](docs/desktop.md).
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

### Notes

- A2A and Analyze are core features; they will ship in the next `@ninemind/agentgem`
  npm release.

## [0.1.1]

- Initial public release: secret-safe Gem capture, the manifest + lock archive,
  composition, the GitHub-backed registry, deploy targets (Eve, Flue, OpenAI Sandbox,
  Bedrock AgentCore, Claude Managed Agents), and the MCP-native path. Published to npm
  as [`@ninemind/agentgem`](https://www.npmjs.com/package/@ninemind/agentgem).

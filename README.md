<p align="center">
  <a href="https://agentgem.ninemind.ai"><img src="docs/banner.svg" alt="AgentGem — your agent works locally. Gem it." width="100%"></a>
</p>

<p align="center">
  <a href="https://github.com/ninemindai/agentgem/actions/workflows/ci.yml"><img src="https://github.com/ninemindai/agentgem/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-9a3324" alt="MIT license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-LTS-1f6b4f" alt="Node LTS"></a>
  <a href="https://agentback.dev"><img src="https://img.shields.io/badge/built_on-AgentBack-b08436" alt="Built on AgentBack"></a>
  <a href="docs/concepts.md"><img src="https://img.shields.io/badge/MCP-native-211c15" alt="MCP-native"></a>
</p>

> A local web UI that introspects your coding-agent config, redacts secrets at
> capture, and builds a portable, composable **Gem**.
>
> **[agentgem.ninemind.ai](https://agentgem.ninemind.ai)**

AgentGem reads your coding-agent config — skills, MCP servers, and `CLAUDE.md` —
**redacts secrets the moment they're read**, and produces a **Gem**: a manifest + lock
archive you can publish to a GitHub-backed registry, merge with other Gems, and deploy to
several targets. A browser can't read `~/.claude` (it's sandboxed), so AgentGem runs a
small server on your machine; secrets never leave your device — what crosses any boundary
is a config *shape* with `<redacted>` in place of every sensitive value.

Built on [AgentBack](https://www.npmjs.com/org/agentback), ninemind's AI-native API/MCP
framework: every operation is defined once as a Zod contract and exposed as a REST
endpoint, an MCP tool, and an OpenAPI 3.1 document — so the web page and your local agent
call exactly the same thing.

## What it provides

- **Secret-safe capture** — redaction by value and by key name, before anything reaches a
  REST response, an MCP result, the live preview, or the built Gem.
- **A neutral Gem source** — a manifest + lock archive that isn't tied to any runtime.
  Build once; install into a local testbed, merge, publish, or compile to a target without
  re-reading raw config.
- **Composition** — the manifest/lock split lets small, focused Gems be reconciled into
  larger agents with a single re-resolved lock, not a pile of overlapping config.
- **Deploy targets** — Eve and OpenAI Sandbox (code-gen), Flue (materialize, deployable to
  Cloudflare), and Bedrock AgentCore (managed backend); code-gen targets share a common
  `compose` step.
- **A GitHub-backed registry** — publish, resolve, merge, and install composable Gems over
  the same archive format.
- **An agent-native path** — every operation is also an MCP tool, so your local agent can
  build Gems over `/mcp` with no browser involved.

## Usage

Requires Node.js ≥ 22 and a coding-agent config at `~/.claude`.

```bash
npx @ninemind/agentgem              # run without installing
# or install the `agentgem` command globally:
npm install -g @ninemind/agentgem
agentgem                            # → http://127.0.0.1:4317
agentgem --port 8080                # override the port (also honors $PORT)
```

The server starts on `127.0.0.1` (default port `4317`) and prints:

```
agentgem listening at http://127.0.0.1:4317
  UI:       http://127.0.0.1:4317/
  API:      http://127.0.0.1:4317/api/inventory  ·  POST http://127.0.0.1:4317/api/gem
  Explorer: http://127.0.0.1:4317/explorer/
  MCP:      http://127.0.0.1:4317/mcp
```

| Path        | What it is                                              |
| ----------- | ------------------------------------------------------- |
| `/`         | The Gem Builder web UI                                  |
| `/explorer` | Swagger UI for the REST API (from the OpenAPI document) |
| `/mcp`      | The MCP endpoint — the same contract, for your agent    |

Open `/`, tick the skills / MCP servers / `CLAUDE.md` you want, name the Gem, and watch
the live `gem.json` render with secrets already shown as `<redacted>`. Download it — that
archive is what every target and the registry consume.

Append `?dir=/path/to/.claude` to introspect a config directory other than the
default `~/.claude`.

### From source

To hack on AgentGem, clone the repo and use [pnpm](https://pnpm.io/) (AgentBack
uses legacy decorators, so it builds with `tsc`, then runs `dist/`):

```bash
pnpm install
pnpm dev        # build + start in one step (→ node dist/index.js)
pnpm test       # tsc -b && vitest run — tests run against compiled dist/
pnpm clean      # rm -rf dist *.tsbuildinfo (run before testing after renames/moves)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Layering

Depends on AgentBack: `@agentback/core` (lifecycle), `@agentback/rest` +
`@agentback/rest-explorer` (HTTP + Swagger UI), `@agentback/mcp` + `@agentback/mcp-http`
(MCP over HTTP), and `@agentback/openapi` (the OpenAPI 3.1 document). The web UI, the REST
API, and the MCP endpoint are three boundaries over one set of Zod contracts —
`src/index.ts` wires them onto a single `RestApplication`.

For deeper reference, see [`docs/`](docs/index.md):
[getting started](docs/getting-started.md) ·
[concepts](docs/concepts.md) ·
[targets & deploy](docs/targets.md) ·
[registry](docs/registry.md).

## License

[MIT](LICENSE) © ninemind.ai

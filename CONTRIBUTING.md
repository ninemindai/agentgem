# Contributing to AgentGem

Thanks for your interest in improving AgentGem! This guide covers local setup,
the build/test loop, and how to submit changes.

## Prerequisites

- **Node.js** (LTS) and [**pnpm**](https://pnpm.io/)
- A coding-agent config at `~/.claude` (skills, MCP servers, `CLAUDE.md`) to
  introspect during development

## Setup

```bash
pnpm install
pnpm build             # AgentBack uses legacy decorators — build with tsc, then run dist/
pnpm start             # → node dist/index.js, serves http://127.0.0.1:4317
```

Server credentials (`ANTHROPIC_API_KEY`, `VERCEL_TOKEN`, `CLOUDFLARE_API_TOKEN`)
are set through the AgentGem UI/API and persisted to `~/.agentgem/.env`
(mode `0600`, outside the repo) — so real secrets stay out of version control.
A repo-root `.env` is still honored as a local dev override if you create one,
but it's not required.

During development, `pnpm dev` builds and starts in one step. Use `PORT` to
override the port and `?dir=/path/to/.claude` to introspect a non-default config
directory.

## Build & test

```bash
pnpm test    # tsc -b && vitest run — tests run against compiled dist/
pnpm clean   # rm -rf dist *.tsbuildinfo
```

> **Tests run against compiled `dist/`, not `src/`.** After renaming or moving
> files, run `pnpm clean` before `pnpm test` so stale compiled output doesn't
> mask the change.

Please make sure `pnpm test` passes before opening a PR.

## Architecture in one paragraph

AgentGem is built on [AgentBack](https://www.npmjs.com/org/agentback): every
operation is defined once as a Zod contract and exposed three ways — a REST
endpoint, an MCP tool, and an OpenAPI 3.1 document. `src/index.ts` wires all
three boundaries onto a single `RestApplication`. When you add an operation,
add it as a contract so all three surfaces stay in sync. See
[`docs/`](docs/index.md) — especially
[architecture](docs/architecture.md) and [concepts](docs/concepts.md) — for the
full picture.

## Submitting changes

1. **Fork** and create a topic branch (`git checkout -b my-change`). If you have
   commit access, work in a `git worktree` to keep sessions isolated (see
   `CLAUDE.md`).
2. Keep changes focused; match the surrounding code's style and comment density.
3. Run `pnpm test` and confirm it's green.
4. Write a clear commit message and PR description explaining the *why*.
5. Open a PR against `main` and fill out the template.

## Security issues

Do **not** open a public issue for security problems — especially anything that
could leak a real secret past redaction. See [SECURITY.md](SECURITY.md) for
private reporting.

## Code of conduct

By participating, you agree to uphold our
[Code of Conduct](CODE_OF_CONDUCT.md).

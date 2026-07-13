# Enterprise deployment — private server + client config

> **Design spec:** [`docs/superpowers/specs/2026-07-12-desktop-client-mode-no-pglite-design.md`](../superpowers/specs/2026-07-12-desktop-client-mode-no-pglite-design.md)

AgentGem operates in two deployment modes, selected by whether `DATABASE_URL` is set. This enables private enterprise deployments where an organization runs its own isolated instance of the AgentGem server.

## Two modes

### Server mode — DATABASE_URL set

The full aggregator runs on Postgres. This is the mode for:

- **Public production** (`api.agentgem.ai` on Fly) — `DATABASE_URL` points to shared Neon Postgres.
- **Private enterprise deployment** — an enterprise runs its own instance of the same server image against its own `DATABASE_URL` (its own Postgres), so all attestations, outcomes, and catalog data stay entirely within the enterprise tenant and never touch the public network.

Entry point: **`src/index.ts`** (server entry). Contains the full aggregator (`AggregatorController`, better-auth, gating, OG cards, GitHub App, registry upload-publish) mounted conditionally on a valid Postgres connection.

When the server boots, it logs the aggregator mode:

```
aggregator: postgres  # or: pglite (for development, when DATABASE_URL is unset)
```

### Client mode — DATABASE_URL unset (desktop)

A pure API client with no database. The shipped consumer desktop always runs in this mode, configured to reach a hosted aggregator (either public or enterprise) over HTTP.

Entry point: **`src/client.ts`** (desktop entry). Contains only the console static assets, client-side controllers (`GemController`, `PlayController`, `DreamController`), and the same-origin proxies (`ShareProxyController`, `BenchmarkProxyController`) that forward aggregator requests to the hosted endpoint. The desktop bundle contains **no** aggregator code, database drivers, or PGlite runtime assets.

## Private enterprise deployment

An enterprise deployment is a full server-mode instance running the same `src/index.ts` image as the public service, with three differences:

1. **Isolated database**: operator sets their own `DATABASE_URL` (their own Postgres instance), so catalog/outcomes/attestations are tenant-isolated.
2. **Custom origin**: the server runs at `https://api.<enterprise>.internal` (or another private domain), not the public `api.agentgem.ai`.
3. **Enterprise desktops**: consumer desktops are configured with `AGENTGEM_AGGREGATOR_URL=https://api.<enterprise>.internal` (instead of the public default) so they reach the private API.

### Deployment env vars

**Server instance (enterprise or public):**

- `DATABASE_URL` — postgres connection string (required; sets server mode). Example: `postgresql://user@host/agentgem`
- `AGENTGEM_WEB_ORIGINS` — comma-separated origin whitelist for credentialed CORS (e.g., `https://app.enterprise.internal,https://web.enterprise.internal`). **Omit `https://api.enterprise.internal` here** — it's the API itself, not a consumer origin.
- `ORIGIN_SHARED_SECRET`, `AGENTGEM_GITHUB_CLIENT_ID`, `AGENTGEM_GITHUB_CLIENT_SECRET`, etc. — other server config per [`fly-neon.md`](./fly-neon.md) One-time setup.

**Consumer desktop (client mode):**

- `AGENTGEM_AGGREGATOR_URL` — URL of the hosted aggregator. Default: `https://api.agentgem.ai` (public). Enterprise: `https://api.<enterprise>.internal` (private).
- `AGENTGEM_WEB_ORIGINS` — origin whitelist for the console (same origins you registered on the server). Enterprise install might default to `https://app.<enterprise>.internal`.
- **Never** set `DATABASE_URL` on the consumer desktop — it is client-only and has no database.

The desktop entry (`src/client.ts`) never receives a `DATABASE_URL` and does not mount the aggregator. Missing `DATABASE_URL` in the desktop is correct behavior, not an error to troubleshoot.

## Tree-shaking guarantee

Desktop bundles built from `src/client.ts` contain no `@agentgem/aggregator`, better-auth, `pg`, or PGlite symbols. The esbuild config (in `desktop/scripts/bundle-core.mjs`) uses the client entry to achieve this without explicit externals or dead-code directives: because the aggregator path is unreachable from `client.ts`, it is never imported, tree-shaken, and never enters the final bundle.

Verification (this is exactly what `bundle-core.mjs` asserts on every build, so a normal
`node desktop/scripts/bundle-core.mjs` already fails loudly if any of these leak):

```bash
# After a desktop build, the bundled client entry must contain none of the server-dep symbols:
grep -nE "@electric-sql/pglite|new PGlite\(|AggregatorController|drizzle-orm/pglite" desktop/core-dist/index.mjs
# Should output nothing (no matches)
```

Note: don't grep the bare word `aggregator` — the client legitimately contains the string
`/api/aggregator/benchmarks` (the URL the `BenchmarkProxyController` forwards to over HTTP);
that is a request path, not the aggregator code.

Server bundles built from `src/index.ts` include the full aggregator, as expected.

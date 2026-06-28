# Container image for the agentgem server (#38).
#
# Single-stage on purpose: it runs the project's already-verified build + start
# steps (`pnpm build` → `node dist/index.js`) with no cross-stage node_modules
# copy, sidestepping pnpm's symlinked-store gotchas. Larger image, but correct by
# construction. A multi-stage slim image is a fine follow-up optimization.
#
# The install+build recipe below is verified: `pnpm install --frozen-lockfile &&
# pnpm build` was run from a clean checkout (no node_modules) and produced
# dist/index.js + dist/public/console. What was NOT run (no Docker where this was
# authored) is the layer build in node:24-slim itself — so `docker build .` once
# in your environment to confirm the base image (corepack + native deps) before
# relying on it.
FROM node:24-slim

WORKDIR /app

# The server defaults to 127.0.0.1 (loopback) for local safety; a container must
# accept external traffic, so bind 0.0.0.0 — see serverHost() in src/index.ts.
ENV HOST=0.0.0.0 \
    PORT=4317

# corepack ships the pinned pnpm (package.json -> "packageManager": "pnpm@10.29.2").
RUN corepack enable

# .dockerignore keeps the host's node_modules / dist / .env out, so this is clean.
COPY . .

# Full install (devDeps included — the build needs tsc + esbuild), then build
# (tsc -b + the console SPA esbuild bundle into dist/public/console).
RUN pnpm install --frozen-lockfile && pnpm build

EXPOSE 4317

# Liveness probe — GET /healthz → 200 (src/index.ts). Uses Node 24's built-in
# fetch, so no curl/wget needs to be installed in the slim image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form so node is PID 1 and receives SIGTERM directly → installGracefulShutdown
# drains + closes the pg pool, then exits. Run with `--init` if you want zombie reaping.
CMD ["node", "dist/index.js"]

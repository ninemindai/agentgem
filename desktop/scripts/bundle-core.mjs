// Bundle the AgentGem core (repo `dist`, ESM) into a single self-contained file
// the packaged Electron app can load. The loose `dist` can't be shipped directly:
// it's ESM with no `type:module` marker once copied, and it needs its node_modules.
//
// Statically-imported deps (agentback, aws-sdk, anthropic) are inlined by esbuild.
// --keep-names is required because AgentBack's DI keys bindings on class names.
// A createRequire/dirname banner lets the ESM bundle satisfy the dynamic require()s
// that CJS deps perform. AgentBack additionally requires its optional REST peers
// (express, cors) dynamically at runtime, so esbuild can't see them — we install
// those into the output node_modules next to the bundle.
//
// Output (desktop/core-dist) is shipped as resources/core via electron-builder
// extraResources, and resolved at runtime by core.ts's packaged candidate.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync as __rf } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // desktop/scripts
const desktop = join(here, "..");
const repo = join(desktop, "..");
const out = join(desktop, "core-dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const banner =
  "import { createRequire as __cr } from 'module';" +
  "import { fileURLToPath as __f } from 'url';" +
  "import { dirname as __d } from 'path';" +
  "const require = __cr(import.meta.url);" +
  "const __filename = __f(import.meta.url);" +
  "const __dirname = __d(__filename);";

await build({
  entryPoints: [join(repo, "dist", "client.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  keepNames: true,
  // jsdom (via @agentgem/play's gameGate load-smoke) loads a sibling `xhr-sync-worker.js`
  // through a path computed at runtime, which esbuild can't inline — so bundling it produces
  // a "Cannot find module './xhr-sync-worker.js'" crash at load. Keep it external and install
  // it on disk next to the bundle (same treatment as express/cors below) so its files survive.
  external: ["electron", "jsdom"],
  banner: { js: banner },
  outfile: join(out, "index.mjs"),
});

// The core serves index.html from disk relative to its own location; ship the assets.
cpSync(join(repo, "dist", "public"), join(out, "public"), { recursive: true });

// Install the dynamically-required REST peers next to the bundle so the bundle's
// createRequire("express"/"cors") resolves them from core-dist/node_modules.
//
// DERIVE the jsdom range; do not hardcode it. It was the literal "^24" here from 2026-07-08 until
// 2026-07-28 while the rest of the repo moved to ^29: `chore(deps)` b23bea03 swept jsdom 24/25 -> 29
// across all nine package.jsons and could not see a version living inside a JSON.stringify in a build
// script. The desktop app therefore ran gameGate's load-smoke on jsdom 24 — a version whose engines
// field (`>=18`) predates the Node 24 the app requires, and which none of the smoke's calibration
// (the ~300ms/~520ms timings behind SMOKE_TIMEOUT_MS, the canvas stub set) was ever measured against.
// A pin encoded as data in code is invisible to every dependency tool; reading the owning manifest
// makes the next bump propagate on its own, and the throw turns a rename into a loud build failure
// rather than a silent return to the drift.
const pinFrom = (manifest, field, name) => {
  const range = JSON.parse(__rf(manifest, "utf8"))[field]?.[name];
  if (!range) throw new Error(`bundle-core: no ${field}.${name} in ${manifest} — the pin source moved`);
  return range;
};

// express/cors come from @agentback/rest's peerDependencies, because that is the contract they have
// to satisfy — `rest.server.js`'s loadExpress() does `nodeRequire()('express')`, a runtime require
// esbuild cannot see, so whatever npm installs HERE is what the REST server actually runs on.
//
// They were the literals "^4"/"^2" from 435fd026 until 2026-07-28, and express 4 outlived the peer's
// move to ^5.2.1. That did not merely ship a stale major — it split the app in two. @agentback's
// mcp-http and rest-explorer depend on express STATICALLY, so esbuild inlines express 5 into the
// bundle, while rest's dynamic require picked up the express 4 on disk: one process, two express
// majors, with the primary REST server on the one its own peer range excludes. Deriving both ends the
// split at its source.
const restPkg = join(repo, "node_modules", "@agentback", "rest", "package.json");
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "agentgem-core",
      private: true,
      type: "module",
      dependencies: {
        express: pinFrom(restPkg, "peerDependencies", "express"),
        cors: pinFrom(restPkg, "peerDependencies", "cors"),
        jsdom: pinFrom(join(repo, "package.json"), "dependencies", "jsdom"),
      },
    },
    null,
    2,
  ),
);
// Run npm through a shell so Windows resolves npm.cmd — Node 22 refuses to spawn
// .cmd/.bat directly without a shell. Command and args are static (no injection).
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: out,
  stdio: "inherit",
  shell: true,
});

console.log("core bundled →", out);

const __bundle = __rf(join(out, "index.mjs"), "utf8");
// The spec's guarantee is "no @agentgem/aggregator, better-auth, pg, or PGlite in the client
// bundle". These strings only appear if a client-reachable module value-imports a server dep:
// the PGlite/drizzle-pglite dynamic-import specifiers, the AggregatorController class name, or
// better-auth (its package code / the `makeAuth` factory). `pg` is covered transitively — it is
// only reached via drizzle-orm/pglite or the Pool in localDb, both already caught.
for (const forbidden of ["@electric-sql/pglite", "new PGlite(", "AggregatorController", "drizzle-orm/pglite", "makeAuth", "better-auth"]) {
  if (__bundle.includes(forbidden)) {
    throw new Error(`desktop bundle must not contain "${forbidden}" — client entry leaked a server dep`);
  }
}
console.log("bundle check: no aggregator/PGlite symbols ✓");

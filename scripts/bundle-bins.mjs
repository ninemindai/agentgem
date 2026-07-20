// Make the published package self-contained.
//
// The 12 `@agentgem/*` packages are private workspace packages — they are NOT
// published to npm. Without bundling, the loose `tsc` output in `dist/` carries
// bare `import ... from "@agentgem/model"` specifiers that an `npm i -g` consumer
// cannot resolve. This script inlines every `@agentgem/*` package (and the root's
// own dist modules) into each published entrypoint, while keeping the REAL npm
// dependencies (declared in package.json `dependencies`) external so the
// consumer's install provides them. Same approach as desktop/scripts/bundle-core.mjs.
//
// Runs only at publish time (prepublishOnly). The in-repo build + deploy keep the
// loose dist and resolve `@agentgem/*` via pnpm workspace symlinks, so they are
// unaffected by this step.
import { build } from "esbuild";
import { readFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // scripts/
const repo = join(here, "..");
const dist = join(repo, "dist");

const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
// Everything declared as a runtime dependency stays external (npm installs it for
// the consumer). `@agentgem/*` are devDependencies now, so they are NOT in this
// list and therefore get inlined.
//
// Because the `@agentgem/*` packages are inlined, THEIR runtime dependencies are
// pulled into this graph too — but only the ROOT's `dependencies` are external
// here. A workspace package's dep that the root does not also declare gets
// inlined, which breaks any package that resolves its own files at runtime
// (jsdom's `require.resolve("./xhr-sync-worker.js")` is why `jsdom` is a root
// dependency despite only `@agentgem/play` importing it).
const external = Object.keys(pkg.dependencies ?? {});

// A createRequire/__dirname banner so any bundled module that performs a CJS
// require() or reads __dirname keeps working inside the ESM bundle.
const banner = {
  js:
    "import { createRequire as __cr } from 'module';" +
    "import { fileURLToPath as __f } from 'url';" +
    "import { dirname as __d } from 'path';" +
    "const require = __cr(import.meta.url);" +
    "const __filename = __f(import.meta.url);" +
    "const __dirname = __d(__filename);",
};

// The published entrypoints: the three bins + the app bootstrap (`start` script)
// + the scorecard warm worker. Every `bin` in package.json must be listed here, or it
// ships with unresolvable bare `@agentgem/*` imports and dies at startup on a
// consumer's install. `warm/scorecardWorker.js` is spawned by `new Worker(path)`, so
// it is an entrypoint the bundler cannot see from any import graph — it needs the same
// treatment or the worker thread dies on a consumer's install (the parent then logs and
// falls back to warming inline, i.e. silently slow).
const entries = ["cli.js", "client.js", "distill/mcpServer.js", "goldmine/mcpServer.js", "warm/scorecardWorker.js", "transcriptParseWorker.js"];

// `dist/client.js` self-runs behind `isMain(import.meta)` so that `node dist/client.js`
// boots it directly. That guard compares `import.meta.url` to `process.argv[1]`.
// Inlining it into cli.js rewrites its `import.meta.url` to cli.js's own URL — which IS
// argv[1] — so the guard flips true and every `agentgem` invocation double-boots.
// Keep it external from the cli bundle: it stays a sibling file on disk, the URLs differ
// again, and cli.js imports `runClient` from it at runtime.
const externalFor = (rel) => (rel === "cli.js" ? [...external, "./client.js"] : external);

for (const rel of entries) {
  const infile = join(dist, rel);
  if (!existsSync(infile)) throw new Error(`missing entrypoint: dist/${rel}`);
  const tmp = `${infile}.bundled`;
  await build({
    entryPoints: [infile],
    outfile: tmp,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: externalFor(rel),
    keepNames: true, // AgentBack DI binds on class names
    banner,
    logLevel: "warning",
  });
  // Read pristine loose dist for all entries first, then swap in the bundles.
  renameSync(tmp, infile);
  console.log(`bundled dist/${rel}`);
}
console.log("bundle-bins: done");

// Bundle the console SPA into ONE self-contained dist/index.html: esbuild bundles
// main.tsx (JS + imported CSS) into memory, then we inline both into an HTML
// shell. A single file means the agentgem server serves it with one route
// (readFileSync), exactly like the vanilla index.html — no static middleware.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");

const result = await build({
  entryPoints: [join(here, "src", "main.tsx")],
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  write: false,
  loader: { ".css": "css" },
  outdir: out,
});

let js = "";
let css = "";
for (const f of result.outputFiles) {
  if (f.path.endsWith(".js")) js = f.text;
  else if (f.path.endsWith(".css")) css = f.text;
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>AgentGem Console</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..600;1,9..144,400..500&family=Hanken+Grotesk:wght@400..700&display=swap" rel="stylesheet" />
<style>${css}</style>
</head>
<body>
<!-- Boot splash: static HTML painted before the inlined bundle parses + React
     mounts (and while web fonts load). createRoot().render() clears #root on its
     first commit, so this needs no teardown. Markup mirrors shell/Loading.tsx —
     keep them in sync; the .gem-loading styles come from the inlined theme.css. -->
<div id="root"><div class="boot-splash" role="status" aria-live="polite" aria-busy="true"><div class="gem-loading"><svg class="gem-loading__mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path class="gem-loading__fill" d="M6 3h12l4 6-10 12L2 9l4-6Z"/><path class="gem-loading__facets" d="M2 9h20M9 3 7 9l5 12M15 3l2 6-5 12"/><path class="gem-loading__rim" d="M6 3h12l4 6-10 12L2 9l4-6Z"/><path class="gem-loading__glint" d="M6 3h12l4 6-10 12L2 9l4-6Z" pathLength="100"/></svg><span class="gem-loading__label">Loading…</span></div></div></div>
<script type="module">${js}</script>
</body>
</html>
`;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), html);
console.log(`[console] wrote ${join(out, "index.html")} (${html.length} bytes)`);

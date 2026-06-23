# AgentGem Website — Markdown-Sourced Static Site (Design)

**Date:** 2026-06-23
**Status:** Approved design, pre-implementation
**Project:** `agentgem` website (`website/` + root-level `docs/*.md`)
**Scope:** A landing page plus a small docs set for the AgentGem project, built the
same way as the sibling `agentback` site: **markdown is the single source of truth**,
a `website/build.mjs` renderer turns it into static HTML in `website/dist/`, and the
homepage + design system are hand-authored vanilla HTML/CSS in the "Lapidary Ledger"
aesthetic the app already uses.

---

## 1. Goals & non-goals

**Goals**
- A polished marketing homepage explaining what AgentGem is and the Gem workflow.
- Four user-facing docs pages: Getting Started, Concepts, Targets & Deploy, Registry
  (plus a docs index).
- Markdown source of truth at repo-root `docs/`, so docs read well on GitHub and as
  raw `.md`, and HTML is generated — never hand-maintained in two places.
- Agent-native output: each page emits HTML **and** copies its raw `.md` alongside;
  generate `llms.txt` / `llms-full.txt` for machine consumption.
- Visual cohesion with the app's Lapidary Ledger design (warm paper, terracotta seal,
  emerald = certified; Fraunces / Hanken Grotesk / JetBrains Mono).

**Non-goals (YAGNI)**
- No JS framework, no client-side routing, no search, no dark-mode toggle, no analytics.
- No blog, no mermaid→SVG diagram pipeline, no Cloudflare edge worker, no `.well-known/*`
  catalogs, no CNAME/analytics token. (All are easy to graft on later by mirroring
  agentback if desired.)
- No live API calls from the site — any `gem.json`/CLI snippets are static and illustrative.
- The build does **not** touch the existing internal `docs/superpowers/**` specs and
  plans; it renders only an explicit allow-list of doc pages.

## 2. Approach (mirrors `agentback/website`)

The reference site keeps `docs/**.md` at repo root and treats `website/` as a pure
renderer. `build.mjs` walks a `DOC_PAGES` allow-list, renders each with `marked`, wraps
it in a shared `docShell`, and writes HTML plus the copied `.md` into `website/dist/`.
A single `NAV_SECTIONS` definition drives the human docs sidebar, `llms.txt`, and
`sitemap.xml`. We adapt that pattern, trimmed to AgentGem's scope.

## 3. File layout

```
docs/                          # SOURCE OF TRUTH (new user-facing markdown at repo root)
  index.md                     # Docs index / landing
  getting-started.md           # install, run, build your first Gem
  concepts.md                  # what a Gem is, archive format, redaction boundary, AgentBack one-contract
  targets.md                   # Eve, Flue, OpenAI Sandbox, Bedrock AgentCore; publish/undeploy
  registry.md                  # GitHub-backed registry: publish/resolve/merge/install
  superpowers/**               # EXISTING internal specs/plans — NOT rendered, untouched

website/
  index.html                   # Hand-written homepage (Lapidary Ledger landing)
  styles.css                   # Shared design system (tokens lifted from src/public/index.html)
  build.mjs                    # md -> dist renderer (adapted + trimmed from agentback)
  assets/
    gem.svg                    # gem mark used in nav + hero
  dist/                        # BUILD OUTPUT — git-ignored
    index.html
    styles.css
    assets/gem.svg
    docs/
      index.html        index.md
      getting-started.html  getting-started.md
      concepts.html         concepts.md
      targets.html          targets.md
      registry.html         registry.md
    llms.txt
    llms-full.txt
    sitemap.xml
    robots.txt
```

`website/dist/` is added to `.gitignore`.

## 4. `build.mjs` responsibilities

Adapted from `agentback/website/build.mjs`, keeping these pieces and dropping the rest:

- **Constants:** `root` (parent of `website/`), `out = website/dist`, `GITHUB` repo URL,
  `DOMAIN`/`SITE` (placeholder e.g. `agentgem.dev` — confirmed/changed at deploy time).
- **`DOC_PAGES`** — explicit list of the five `docs/*.md` source files to render.
- **`NAV_SECTIONS`** — grouped `[path, label]` pairs; single source for the sidebar,
  `llms.txt`, and `sitemap.xml`.
- **`mapTarget` / link rewriting** — rewrite internal `.md` links to `.html`; point
  links outside the allow-list (e.g. repo files) at GitHub.
- **`addHeadingIds`** — slugged anchors on headings for deep-linking.
- **`docShell({title, body, outPage})`** — wraps rendered markdown in shared chrome:
  top nav (gem mark + Home / Docs links), a docs sidebar from `NAV_SECTIONS`, the prose
  column, and a footer (incl. a link to `llms.txt`). Uses `styles.css`.
- **Emit per page:** `<name>.html` (shelled) **and** copy the raw `<name>.md`.
- **Static copy:** homepage `index.html`, `styles.css`, `assets/` into `dist/`.
- **Machine indexes:** `llms.txt` (annotated index from `NAV_SECTIONS`), `llms-full.txt`
  (concatenated corpus), `sitemap.xml`, `robots.txt`.
- **`.nojekyll`** so GitHub Pages serves `_`-free as-is (cheap, harmless).

**Dropped from the reference:** blog rendering, mermaid/diagram pipeline, Cloudflare
edge worker, `.well-known/*` catalogs, CNAME, CF analytics token, CSS cache-busting
versioning (a single static `styles.css` link is fine at this scale).

## 5. Design system (`styles.css`)

Lift the token set verbatim from `src/public/index.html` so the site and app share one
brand:

- Palette: `--paper #f4efe3`, `--card #fbf8f1`, `--ink #211c15`, terracotta
  `--accent #9a3324`, emerald `--gem #1f6b4f`, `--gold #b08436`, plus line/muted tokens.
- Background: the paper radial-gradients + the inline SVG fractal-noise overlay.
- Fonts: Fraunces (display), Hanken Grotesk (UI), JetBrains Mono (code/labels) via
  Google Fonts `<link>` in the shell + homepage.
- Components: top nav, hero, the 4-station "Gem workflow" rail (diamond-rotated nodes,
  emerald = done / terracotta = active, mirroring the app's stage rail), feature cards,
  code blocks, callouts, docs sidebar + prose, footer. Responsive single-column collapse
  on narrow viewports.

## 6. Homepage (`website/index.html`)

Hand-authored, standalone. Sections:
1. **Nav** — gem mark, "AgentGem" wordmark, links (Docs, Getting Started, GitHub).
2. **Hero** — gem mark, tagline ("Turn your coding-agent config into a secret-safe,
   composable Gem — built on AgentBack"), primary CTA → Getting Started, secondary → Concepts.
3. **Gem workflow rail** — Introspect → Select & Redact → Build Gem → Publish / Deploy.
4. **Feature cards** — one-contract (REST + MCP from one Zod def), secret redaction at
   capture, composable registry, multi-target deploy (Eve / Flue / OpenAI Sandbox / AgentCore).
5. **Illustrative preview** — a static, pretty-printed redacted `gem.json` snippet showing
   `"<redacted>"` values.
6. **Footer** — doc links, GitHub, llms.txt.

## 7. Docs content (the five `docs/*.md`)

- **`index.md`** — what AgentGem is in a paragraph; links to the four pages.
- **`getting-started.md`** — `pnpm install && pnpm build && pnpm start`; what comes up
  (UI at `/`, Swagger at `/explorer`, MCP at `/mcp`); build your first Gem end-to-end.
- **`concepts.md`** — what a Gem is; the archive format (manifest + lock); the redaction
  trust boundary (redact at capture, never serve raw secrets); the AgentBack
  one-contract model (one Zod def → REST endpoint + MCP tool + OpenAPI).
- **`targets.md`** — the deploy targets (Eve, Flue, OpenAI Sandbox, Bedrock AgentCore),
  what each produces, and the publish / undeploy lifecycle.
- **`registry.md`** — the GitHub-backed Gem registry: publish, resolve, merge, install
  composable Gems.

Content is drawn from the existing specs in `docs/superpowers/specs/**` and the project
memory; it describes current shipped behavior, not aspirations.

## 8. Build & run

- Add `marked` as a `devDependency`.
- Add a script: `"build:site": "node website/build.mjs"`.
- `pnpm build:site` writes `website/dist/`; serve it with any static server for preview
  (`npx serve website/dist`), or open `website/dist/index.html` directly.
- `website/dist/` is git-ignored.

## 9. Testing / verification

- Run `pnpm build:site`; confirm `website/dist/` contains the homepage, five docs HTML +
  copied `.md`, `llms.txt`, `llms-full.txt`, `sitemap.xml`, `robots.txt`.
- Smoke-test with the gstack browser at verify time: load `dist/index.html`, confirm the
  hero + workflow rail render, nav links to a docs page work, the docs sidebar renders,
  internal `.md`→`.html` links resolve, and the illustrative preview shows `<redacted>`.
- Confirm the build does not read or emit anything under `docs/superpowers/**`.

## 10. Out of scope (later)

- Deployment wiring (GitHub Pages / Vercel / Cloudflare) and a real domain.
- Blog, diagrams, `.well-known/*` agent catalogs, analytics — mirror agentback when needed.
- Auto-generating docs from the OpenAPI contract.

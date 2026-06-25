// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: agentgem website builder.
//
// Builds the AgentGem static site into website/dist:
//   /            hand-written homepage (website/index.html)
//   /docs/**     docs/*.md rendered to HTML in a shared shell (+ raw .md copied)
//   /llms.txt    agent-readable site index; /llms-full.txt the full corpus
//   /sitemap.xml /robots.txt
// Markdown at the repo root stays the single source of truth — nothing is
// duplicated here. The internal docs/superpowers/** specs are NOT rendered;
// only the explicit DOC_PAGES allow-list is.

import {marked} from 'marked';
import {markedHighlight} from 'marked-highlight';
import hljs from 'highlight.js';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const websiteDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(websiteDir, '..');
const out = path.join(websiteDir, 'dist');
const GITHUB = 'https://github.com/ninemindai/agentgem';
const DOMAIN = 'agentgem.ninemind.ai';
const SITE = `https://${DOMAIN}`;

// Build-time syntax highlighting: highlight.js emits `hljs-*` class spans into
// the static HTML (no client JS). Themed in styles.css to the warm code palette
// the homepage `.codewrap` sample uses, so docs and marketing code read alike.
marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, {language}).value;
  },
}));

// Markdown sources, repo-relative. Each becomes docs/<name>.html.
const DOC_PAGES = [
  'docs/index.md',
  'docs/getting-started.md',
  'docs/desktop.md',
  'docs/analyze.md',
  'docs/concepts.md',
  'docs/architecture.md',
  'docs/pipeline.md',
  'docs/archive-format.md',
  'docs/redaction.md',
  'docs/api-reference.md',
  'docs/targets.md',
  'docs/a2a.md',
  'docs/registry.md',
  'docs/testbed-and-run.md',
  'docs/development.md',
];

// One nav definition drives the docs sidebar, llms.txt, and the sitemap.
const NAV_SECTIONS = [
  {
    title: 'Start here',
    items: [
      ['docs/index.md', 'Overview'],
      ['docs/getting-started.md', 'Getting started'],
      ['docs/desktop.md', 'Desktop app'],
      ['docs/analyze.md', 'Analyze'],
      ['docs/concepts.md', 'Concepts'],
    ],
  },
  {
    title: 'Architecture & internals',
    items: [
      ['docs/architecture.md', 'Architecture'],
      ['docs/pipeline.md', 'The build pipeline'],
      ['docs/archive-format.md', 'Archive format'],
      ['docs/redaction.md', 'Redaction'],
      ['docs/api-reference.md', 'API reference'],
    ],
  },
  {
    title: 'Distribution',
    items: [
      ['docs/targets.md', 'Targets & deploy'],
      ['docs/a2a.md', 'A2A'],
      ['docs/registry.md', 'Registry'],
      ['docs/testbed-and-run.md', 'Testbed & run'],
    ],
  },
  {
    title: 'Contributing',
    items: [
      ['docs/development.md', 'Development'],
    ],
  },
];

/** Map a repo-relative path to its output path on the site (or an external URL). */
function mapTarget(repoPath) {
  const p = repoPath.replace(/\\/g, '/');
  const md = p.match(/^docs\/(.+)\.md$/);
  if (md && DOC_PAGES.includes(p)) return `docs/${md[1]}.html`;
  // Anything outside the allow-list points at the repo on GitHub.
  const lastSeg = p.split('/').pop();
  const kind = lastSeg.includes('.') ? 'blob' : 'tree';
  return `${GITHUB}/${kind}/main/${p}`;
}

/** Rewrite a relative .md href (from a docs page) to its .html equivalent. */
function rewriteHref(href) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [pathPart, anchor] = href.split('#');
  const md = pathPart.match(/^(.*?)\.md$/);
  if (md) {
    const rebuilt = `${md[1]}.html`;
    return anchor ? `${rebuilt}#${anchor}` : rebuilt;
  }
  return href;
}

function rewriteHtmlLinks(html) {
  return html.replace(/href="([^"]+)"/g, (_m, href) => `href="${rewriteHref(href)}"`);
}

function slugify(text, used) {
  let slug = text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  if (!slug) slug = 'section';
  let unique = slug;
  let n = 2;
  while (used.has(unique)) unique = `${slug}-${n++}`;
  used.add(unique);
  return unique;
}

/** Add id + hover anchor to h2/h3 for deep-linking. */
function addHeadingIds(html) {
  const used = new Set();
  return html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    const id = slugify(inner, used);
    return `<h${level} id="${id}">${inner}<a class="anchor" href="#${id}" aria-hidden="true">#</a></h${level}>`;
  });
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;

/** Relative prefix from a docs page back to site root (docs/ pages → "../"). */
function relPrefix(outPage) {
  const depth = outPage.split('/').length - 1;
  return '../'.repeat(depth);
}

function sidebar(outPage) {
  const rel = relPrefix(outPage);
  return NAV_SECTIONS.map(section => {
    const links = section.items
      .map(([src, label]) => {
        const target = rel + mapTarget(src);
        const active = mapTarget(src) === outPage ? ' class="active"' : '';
        return `<a href="${target}"${active}>${escapeHtml(label)}</a>`;
      })
      .join('\n');
    return `<div class="grp"><h4>${escapeHtml(section.title)}</h4>\n${links}\n</div>`;
  }).join('\n');
}

function docShell({title, body, outPage}) {
  const rel = relPrefix(outPage);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)} — AgentGem</title>
<link rel="icon" href="${rel}assets/gem.svg" type="image/svg+xml" />
${FONTS}
<link rel="stylesheet" href="${rel}styles.css" />
</head>
<body>
<nav class="nav">
  <div class="nav-in">
    <a class="brand" href="${rel}index.html"><img src="${rel}assets/gem.svg" alt="" />agentgem</a>
    <span class="tag">Docs</span>
    <span class="spacer"></span>
    <div class="nav-links">
      <a href="${rel}docs/index.html">Docs</a>
      <a href="${rel}docs/getting-started.html">Get started</a>
      <a href="${rel}blog/index.html">Blog</a>
      <a href="${GITHUB}">GitHub</a>
    </div>
  </div>
</nav>
<div class="docs">
  <aside class="sidebar">
${sidebar(outPage)}
  </aside>
  <article class="prose">
${body}
  </article>
</div>
<footer class="foot">
  <div class="foot-in">
    <a class="brand" href="${rel}index.html"><img src="${rel}assets/gem.svg" alt="" />agentgem</a>
    <div class="foot-links">
      <a href="${rel}vision.html">Vision</a>
      <a href="${rel}blog/index.html">Blog</a>
      <a href="${rel}docs/getting-started.html">Getting started</a>
      <a href="${rel}docs/concepts.html">Concepts</a>
      <a href="${rel}docs/targets.html">Targets &amp; deploy</a>
      <a href="${rel}docs/registry.html">Registry</a>
      <a href="${rel}llms.txt">llms.txt</a>
      <a href="https://agentback.dev">AgentBack</a>
    </div>
    <span class="note">built on <a href="https://agentback.dev">AgentBack</a></span>
  </div>
</footer>
</body>
</html>
`;
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, {recursive: true});
  for (const entry of fs.readdirSync(src, {withFileTypes: true})) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function write(outPage, content) {
  const file = path.join(out, outPage);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, content);
}

// ── build ──────────────────────────────────────────────────────────────────
fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});

// Static assets: homepage, vision page, stylesheet, gem mark.
fs.copyFileSync(path.join(websiteDir, 'index.html'), path.join(out, 'index.html'));
fs.copyFileSync(path.join(websiteDir, 'vision.html'), path.join(out, 'vision.html'));
fs.copyFileSync(path.join(websiteDir, 'styles.css'), path.join(out, 'styles.css'));

// Blog: repo-local, self-contained HTML at docs/blog/ (an index listing +
// posts/*.html, each its own dark-theme page with inline SVG and CDN fonts).
// Copied verbatim to dist/blog — add a post by dropping a file in docs/blog/posts
// and a card in docs/blog/index.html. Mirrors agentback/website's blog.
copyDir(path.join(root, 'docs', 'blog'), path.join(out, 'blog'));
const blogPosts = fs.existsSync(path.join(root, 'docs', 'blog', 'posts'))
  ? fs.readdirSync(path.join(root, 'docs', 'blog', 'posts')).filter(f => f.endsWith('.html'))
  : [];
copyDir(path.join(websiteDir, 'assets'), path.join(out, 'assets'));

// Diagrams referenced by the docs (./diagrams/*.svg|png), served under /docs/diagrams.
copyDir(path.join(root, 'docs', 'diagrams'), path.join(out, 'docs', 'diagrams'));

// Screenshot referenced by getting-started.md (./screenshot.png), served under /docs.
fs.copyFileSync(path.join(root, 'docs', 'screenshot.png'), path.join(out, 'docs', 'screenshot.png'));

// Render each doc page: HTML in the shell + the raw .md copied alongside.
const docMeta = [];
for (const src of DOC_PAGES) {
  const md = fs.readFileSync(path.join(root, src), 'utf8');
  const outHtml = mapTarget(src);
  const outMd = outHtml.replace(/\.html$/, '.md');

  const titleMatch = md.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : 'AgentGem';

  let html = marked.parse(md);
  html = rewriteHtmlLinks(html);
  html = addHeadingIds(html);

  write(outHtml, docShell({title, body: html, outPage: outHtml}));
  write(outMd, md);
  docMeta.push({src, outHtml, outMd, title});
}

// llms.txt — annotated, agent-readable index from NAV_SECTIONS.
const llmsSections = NAV_SECTIONS.map(section => {
  const lines = section.items.map(([src, label]) => {
    const meta = docMeta.find(d => d.src === src);
    const url = `${SITE}/${meta ? meta.outMd : mapTarget(src)}`;
    return `- [${label}](${url})`;
  });
  return `## ${section.title}\n${lines.join('\n')}`;
}).join('\n\n');

write(
  'llms.txt',
  `# AgentGem

> AgentGem turns your coding-agent config — skills, MCP servers, CLAUDE.md — into a
> secret-safe, composable Gem. Built on AgentBack: one Zod contract becomes a REST
> endpoint and an MCP tool.

The full corpus in one file: ${SITE}/llms-full.txt

${llmsSections}
`,
);

// llms-full.txt — every doc page concatenated.
write(
  'llms-full.txt',
  docMeta
    .map(d => fs.readFileSync(path.join(root, d.src), 'utf8'))
    .join('\n\n---\n\n') + '\n',
);

// sitemap.xml — homepage + every rendered docs HTML page.
const sitemapUrls = [
  `${SITE}/`,
  `${SITE}/vision.html`,
  `${SITE}/blog/index.html`,
  ...blogPosts.map(f => `${SITE}/blog/posts/${f}`),
  ...docMeta.map(d => `${SITE}/${d.outHtml}`),
];
write(
  'sitemap.xml',
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    sitemapUrls.map(u => `  <url><loc>${u}</loc></url>`).join('\n') +
    '\n</urlset>\n',
);

// robots.txt — public docs, crawling welcome.
write(
  'robots.txt',
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`,
);

// .nojekyll so static hosts serve the tree as-is.
write('.nojekyll', '');

console.log(
  `Built ${docMeta.length} docs pages + homepage → ${path.relative(root, out)}`,
);

// Inject OG/Twitter meta into the SPA shell's <head>. String ops only (the shell is tiny and
// stable); the body is preserved so React still hydrates. Mirrors the shape of
// packages/marketplace/src/worker.ts's original injector, upgraded to summary_large_image.
export interface OgTagInput { title: string; description: string; url: string; image: string }

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export function ogTags(o: OgTagInput): string {
  const t = esc(o.title), d = esc(o.description), u = esc(o.url), img = esc(o.image);
  return (
    `<meta property="og:title" content="${t}">` +
    `<meta property="og:description" content="${d}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:url" content="${u}">` +
    `<meta property="og:image" content="${img}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${t}">` +
    `<meta name="twitter:description" content="${d}">` +
    `<meta name="twitter:image" content="${img}">`
  );
}

export function injectHead(shell: string, o: OgTagInput): string {
  return shell
    .replace(/<title>[^<]*<\/title>/i, `<title>${esc(o.title)} — AgentGem</title>`)
    .replace(/<\/head>/i, `${ogTags(o)}</head>`);
}

// Wrap (already-redacted) artifact/dashboard HTML in a strict CSP so the sandboxed frame
// can't reach the network. With sandbox="allow-scripts" (and NO allow-same-origin → null
// origin), the doc runs its own inline JS/CSS but can't read the console's cookies/DOM.
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "img-src data:; font-src data:; media-src data:;";

export function sandboxDoc(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

// Wrap (already-redacted) artifact/dashboard HTML in a strict CSP so the sandboxed frame
// can't reach the network. With sandbox="allow-scripts" (and NO allow-same-origin → null
// origin), the doc runs its own inline JS/CSS but can't read the console's cookies/DOM.
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "img-src data:; font-src data:; media-src data:;";

// A null-origin document (sandbox without allow-same-origin) THROWS a SecurityError on any access to
// localStorage/sessionStorage. Many self-contained games touch storage at the top of their script, so
// that throw kills the whole game before it can run. Inject an in-memory shim (installed only when the
// native access throws) so those games work; state is ephemeral, which is correct for a sealed preview.
// This runs before the game's own scripts because it is placed first inside <head>.
const STORAGE_SHIM =
  "<script>(function(){function make(){var m=Object.create(null);return{" +
  "getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null;}," +
  "setItem:function(k,v){m[k]=String(v);},removeItem:function(k){delete m[k];}," +
  "clear:function(){for(var k in m)delete m[k];},key:function(i){return Object.keys(m)[i]||null;}," +
  "get length(){return Object.keys(m).length;}};}" +
  "['localStorage','sessionStorage'].forEach(function(n){var ok=false;try{window[n]&&window[n].getItem;ok=true;}catch(e){}" +
  "if(!ok){try{Object.defineProperty(window,n,{value:make(),configurable:true});}catch(e){}}});})();</script>";

export function sandboxDoc(html: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}">${STORAGE_SHIM}`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

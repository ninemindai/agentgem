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

// A srcdoc frame inherits the PARENT's document URL as its base, so a bare in-page anchor (<a href="#x">)
// resolves against the host origin (e.g. http://localhost:4317/) rather than the frame's own about:srcdoc.
// Clicking it therefore navigates the sealed null-origin frame to the host root — a cross-document GET that
// originGuard rejects with `{"error":"cross-site request blocked"}`, wiping out the miniapp. Intercept
// same-page anchors in the capture phase and drive location.hash on THIS document instead: that is a
// same-document fragment change, so it scrolls / fires hashchange in-frame (hash-router miniapps keep
// working) and can never reach the host. preventDefault only — the miniapp's own click handlers still run.
const ANCHOR_SHIM =
  "<script>(function(){document.addEventListener('click',function(e){" +
  "var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;" +
  "var h=a.getAttribute('href');if(!h||h.charAt(0)!=='#')return;" +
  "e.preventDefault();try{location.hash=h.slice(1);}catch(_e){}},true);})();</script>";

export function sandboxDoc(html: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}">${STORAGE_SHIM}${ANCHOR_SHIM}`;
  // Force the CSP meta to be the FIRST node in <head>, whatever the input's shape. The old code
  // injected after an existing <head>, so a <script> placed BEFORE that <head> ran at parse time —
  // before the policy applied — and could open a network connection the CSP would otherwise block.
  // DOMParser does NOT execute scripts; HTML5 tree construction relocates any pre-<head> script into
  // <head>. Re-emit with our static CSP first, then the parsed head/body, so the policy parses before
  // any of the document's own scripts when the iframe re-parses this string.
  const doc = new DOMParser().parseFromString(html, "text/html");
  return `<!doctype html><html><head>${head}${doc.head.innerHTML}</head><body>${doc.body.innerHTML}</body></html>`;
}

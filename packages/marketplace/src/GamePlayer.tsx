// packages/marketplace/src/GamePlayer.tsx
import { useEffect, useRef, useState, type CSSProperties } from "react";

// Seal an artifact's HTML: strict CSP (no network) + a null-origin sandbox. Mirrors the console's
// sandboxDoc, including the in-memory localStorage shim so a game that touches storage doesn't crash
// on load in the null-origin frame.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:;";
const STORAGE_SHIM =
  "<script>(function(){function make(){var m=Object.create(null);return{" +
  "getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null;}," +
  "setItem:function(k,v){m[k]=String(v);},removeItem:function(k){delete m[k];}," +
  "clear:function(){for(var k in m)delete m[k];},key:function(i){return Object.keys(m)[i]||null;}," +
  "get length(){return Object.keys(m).length;}};}" +
  "['localStorage','sessionStorage'].forEach(function(n){var ok=false;try{window[n]&&window[n].getItem;ok=true;}catch(e){}" +
  "if(!ok){try{Object.defineProperty(window,n,{value:make(),configurable:true});}catch(e){}}});})();</script>";
function sealedDoc(html: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}">${STORAGE_SHIM}`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

// Sealed mini-game player: null-origin sandboxed iframe (no allow-same-origin → no network).
// Thumbnails render the game at a virtual vw×vh window scaled to fit, so every card frames a game the
// same way. Fullscreen instead gives the iframe the overlay's real size: a game lays itself out against
// its own viewport, so a fake 1200×780 window would only ever be upscaled, never played at screen size.
// interactive=false → a click-through thumbnail; a ⛶ toggle plays it fullscreen. startFullscreen mounts
// straight into the fullscreen overlay (for click-to-play); onExitFullscreen fires when the viewer leaves
// fullscreen (✕ or Esc) so a parent can unmount the live player.
export function GamePlayer({ html, interactive = true, startFullscreen = false, onExitFullscreen, vw = 1200, vh = 780 }:
  { html: string; interactive?: boolean; startFullscreen?: boolean; onExitFullscreen?: () => void; vw?: number; vh?: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0.4);
  const [fs, setFs] = useState(startFullscreen);
  const exitFs = () => { setFs(false); onExitFullscreen?.(); };

  // Load the game only once the frame is laid out. A srcdoc document parses the instant the attribute is
  // set and takes its viewport from the frame's box right then; a freshly mounted frame has not been laid
  // out yet, so the game would size itself against a 0×0 window. Since the frame's viewport never changes
  // afterwards, no resize event ever arrives to correct it. Reading the frame's box forces the pending
  // layout, so the document parses against the real size.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.getBoundingClientRect();
    frame.srcdoc = sealedDoc(html);
  }, [html]);

  useEffect(() => {
    const box = boxRef.current;
    if (fs || !box || typeof ResizeObserver === "undefined") return;
    const measure = () => setScale(Math.min(1, (box.clientWidth || vw) / vw));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [vw, fs]);

  // Esc leaves fullscreen — the expected exit for an immersive click-to-play launch.
  useEffect(() => {
    if (!fs) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") exitFs(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fs]);

  const boxStyle: CSSProperties = fs
    ? { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(12,14,18,.94)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }
    : interactive
      ? { position: "relative", width: "100%", height: Math.round(vh * scale), overflow: "hidden", background: "#0d1117" }
      : { position: "absolute", inset: 0, overflow: "hidden", background: "#0d1117" };

  return (
    <div ref={boxRef} style={boxStyle}>
      <iframe
        ref={frameRef}
        title="mini-game"
        sandbox="allow-scripts"
        style={fs
          ? { width: "100%", height: "100%", border: 0, display: "block", background: "#0d1117" }
          : { width: vw, height: vh, border: 0, display: "block", background: "#fff", pointerEvents: interactive ? "auto" : "none",
              transform: `scale(${scale})`, transformOrigin: "top left" }}
      />
      {interactive && (
        <button onClick={() => (fs ? exitFs() : setFs(true))} title={fs ? "Exit fullscreen" : "Play fullscreen"} aria-label={fs ? "Exit fullscreen" : "Play fullscreen"}
          style={{ position: fs ? "fixed" : "absolute", top: 8, right: 8, zIndex: 1001, width: 30, height: 30, borderRadius: 8,
            border: "1px solid rgba(255,255,255,.25)", background: "rgba(20,22,28,.7)", color: "#fff", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>
          {fs ? "✕" : "⛶"}
        </button>
      )}
    </div>
  );
}

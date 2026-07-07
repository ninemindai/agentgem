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

// Sealed mini-game player: null-origin sandboxed iframe (no allow-same-origin → no network), rendered at
// a virtual window and scaled to fit. interactive=false → a click-through thumbnail; a ⛶ toggle plays it
// fullscreen. Full-window games (html,body{height:100%;overflow:hidden}) show whole, not clipped.
export function GamePlayer({ html, interactive = true, vw = 1200, vh = 780 }: { html: string; interactive?: boolean; vw?: number; vh?: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  const [fs, setFs] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const cw = box.clientWidth || vw, ch = box.clientHeight || vh;
      setScale(fs ? Math.min(cw / vw, ch / vh) : Math.min(1, cw / vw));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [vw, vh, fs]);

  const boxStyle: CSSProperties = fs
    ? { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(12,14,18,.94)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }
    : interactive
      ? { position: "relative", width: "100%", height: Math.round(vh * scale), overflow: "hidden", background: "#0d1117" }
      : { position: "absolute", inset: 0, overflow: "hidden", background: "#0d1117" };

  return (
    <div ref={boxRef} style={boxStyle}>
      <iframe
        title="mini-game"
        sandbox="allow-scripts"
        srcDoc={sealedDoc(html)}
        style={{ width: vw, height: vh, border: 0, display: "block", background: "#fff", pointerEvents: interactive ? "auto" : "none",
          transform: `scale(${scale})`, transformOrigin: fs ? "center" : "top left" }}
      />
      {interactive && (
        <button onClick={() => setFs((v) => !v)} title={fs ? "Exit fullscreen" : "Play fullscreen"} aria-label={fs ? "Exit fullscreen" : "Play fullscreen"}
          style={{ position: fs ? "fixed" : "absolute", top: 8, right: 8, zIndex: 1001, width: 30, height: 30, borderRadius: 8,
            border: "1px solid rgba(255,255,255,.25)", background: "rgba(20,22,28,.7)", color: "#fff", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>
          {fs ? "✕" : "⛶"}
        </button>
      )}
    </div>
  );
}

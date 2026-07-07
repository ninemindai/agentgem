// packages/console/src/panels/Play/Runner.tsx
import { useEffect, useRef, useState } from "react";
import { sandboxDoc } from "../Watch/sandboxDoc.js";
import { makeClient, playSessionDataRoute } from "../../api/routes.js";

// The sealed miniapp player: null-origin iframe (no allow-same-origin), strict CSP via sandboxDoc.
// Miniapps are usually full-window apps (html,body{height:100%;overflow:hidden}), so a short fixed
// iframe would CLIP them. Instead render at a realistic virtual window (vw×vh) and scale that iframe to
// fit — inline it fits the column width; fullscreen it fits the whole viewport so you can actually play it.
// `interactive={false}` renders a live but click-through thumbnail (no fullscreen button; the card owns
// framing + clicks), used by the Arcade grid.
//
// Capability broker: a sealed game can DECLARE `needs` (e.g. ["session-data"]). It has no network, so it
// postMessages the trusted Runner a request; the Runner fetches the host data and feeds it back into the
// iframe. Only requests from THIS iframe, and only a `want` the gem declared in `needs`, are honored.
export function Runner({ html, vw = 1200, vh = 780, interactive = true, name, apiBase, needs }:
  { html: string; vw?: number; vh?: number; interactive?: boolean; name?: string; apiBase?: string; needs?: string[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0.5);
  const [fs, setFs] = useState(false);

  // Broker: feed host data into the sealed iframe on request.
  useEffect(() => {
    if (name == null || apiBase == null || !needs?.includes("session-data")) return; // apiBase="" (same-origin) is valid
    const onMsg = (e: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win || e.source !== win) return;                            // only our own sealed iframe
      const d = e.data as { type?: string; want?: string } | null;
      if (!d || d.type !== "agentgem:request" || !d.want || !needs.includes(d.want)) return; // only declared caps
      if (d.want === "session-data") {
        playSessionDataRoute.call(makeClient(apiBase), { query: { name } })
          .then((data) => win.postMessage({ type: "agentgem:feed", channel: "session-data", data }, "*"))
          .catch(() => { /* shared/offline miniapp: no host data — the game shows its waiting state */ });
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [name, apiBase, needs]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return; // jsdom / non-browser: keep the default
    const measure = () => {
      const cw = box.clientWidth || vw, ch = box.clientHeight || vh;
      // inline: fit width, never upscale. fullscreen: fit both dims so the whole game fills the screen.
      setScale(fs ? Math.min(cw / vw, ch / vh) : Math.min(1, cw / vw));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [vw, vh, fs]);

  const boxStyle: React.CSSProperties = fs
    ? { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(12,14,18,.94)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }
    : interactive
      ? { position: "relative", width: "100%", height: Math.round(vh * scale), overflow: "hidden", border: "1px solid var(--border, #ccc)", borderRadius: 8, background: "#fff" }
      : { position: "absolute", inset: 0, overflow: "hidden", background: "#0d1117" }; // thumbnail: fill the card slot

  return (
    <div ref={boxRef} style={boxStyle}>
      <iframe
        ref={iframeRef}
        title="miniapp preview"
        sandbox="allow-scripts"
        srcDoc={sandboxDoc(html)}
        style={{ width: vw, height: vh, border: 0, display: "block", background: "#fff", pointerEvents: interactive ? "auto" : "none",
          transform: `scale(${scale})`, transformOrigin: fs ? "center" : "top left" }}
      />
      {interactive && (
        <button
          onClick={() => setFs((v) => !v)}
          title={fs ? "Exit fullscreen" : "Play fullscreen"}
          aria-label={fs ? "Exit fullscreen" : "Play fullscreen"}
          style={{ position: fs ? "fixed" : "absolute", top: 8, right: 8, zIndex: 1001,
            width: 30, height: 30, borderRadius: 8, border: "1px solid rgba(255,255,255,.25)",
            background: "rgba(20,22,28,.7)", color: "#fff", cursor: "pointer", fontSize: 14, lineHeight: 1 }}
        >{fs ? "✕" : "⛶"}</button>
      )}
    </div>
  );
}

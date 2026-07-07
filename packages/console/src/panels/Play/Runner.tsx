// packages/console/src/panels/Play/Runner.tsx
import { useEffect, useRef, useState, useCallback } from "react";
import { sandboxDoc } from "../Watch/sandboxDoc.js";
import { makeClient, playSessionDataRoute, inventoryRoute } from "../../api/routes.js";
import { AUTO_CAPS, CAP_LABEL, getConsent, setConsent } from "./consent.js";

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
  const [pending, setPending] = useState<string | null>(null); // a gated capability awaiting consent

  // Fetch the host data for a capability. session-data = the game's own source; local-project-access =
  // the local inventory (skills/mcp/projects). Extend here as capabilities are added.
  const fetchCap = useCallback(async (cap: string): Promise<unknown> => {
    if (name == null || apiBase == null) return null;
    const client = makeClient(apiBase);
    if (cap === "session-data") return playSessionDataRoute.call(client, { query: { name } });
    if (cap === "local-project-access") return inventoryRoute.call(client);
    return null;
  }, [name, apiBase]);

  const feed = useCallback(async (cap: string): Promise<void> => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try { const data = await fetchCap(cap); if (data) win.postMessage({ type: "agentgem:feed", channel: cap, data }, "*"); }
    catch { /* no host data — the game shows its waiting state */ }
  }, [fetchCap]);

  // Capability broker + consent gate. The sealed game (no network) postMessages a request; we honor only
  // requests from THIS iframe and only a `want` the gem declared in `needs`. AUTO caps feed immediately;
  // gated caps require remembered per-gem consent (prompt on first ask). Thumbnails never prompt.
  useEffect(() => {
    if (name == null || apiBase == null || !needs?.length) return; // apiBase="" (same-origin) is valid
    const onMsg = (e: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win || e.source !== win) return;                            // only our own sealed iframe
      const d = e.data as { type?: string; want?: string } | null;
      if (!d || d.type !== "agentgem:request" || !d.want || !needs.includes(d.want)) return; // only declared caps
      const cap = d.want;
      if (AUTO_CAPS.has(cap)) { void feed(cap); return; }
      if (!interactive) return;                                        // thumbnails never prompt/feed sensitive caps
      const decision = getConsent(name, cap);
      if (decision === "granted") void feed(cap);
      else if (decision === null) setPending(cap);                     // ask (once)
      // "denied" → silently ignore
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [name, apiBase, needs, interactive, feed]);

  const decide = (allow: boolean) => {
    if (pending == null || name == null) return;
    setConsent(name, pending, allow ? "granted" : "denied");
    if (allow) void feed(pending);
    setPending(null);
  };

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
      {pending && (
        <div className="play-consent">
          <div className="play-consent__box">
            <div className="play-consent__ico">🔒</div>
            <div className="play-consent__title">“{name}” wants to {CAP_LABEL[pending] ?? pending}</div>
            <div className="play-consent__sub">The game stays sealed (no network of its own) — the host feeds this in only if you allow. Remembered for this game.</div>
            <div className="play-consent__btns">
              <button className="play-btn play-btn--primary" onClick={() => decide(true)}>Allow</button>
              <button className="play-btn" onClick={() => decide(false)}>Deny</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

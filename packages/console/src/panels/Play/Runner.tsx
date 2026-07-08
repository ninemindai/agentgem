// packages/console/src/panels/Play/Runner.tsx
import { useEffect, useRef, useState, useCallback } from "react";
import { sandboxDoc } from "../Watch/sandboxDoc.js";
import { fetchSessions, type WatchSession } from "../Watch/watchStream.js";
import { createUiHost, type UiHost } from "./mcpUiHost.js";
import { CAP_LABEL, getConsent, setConsent } from "./consent.js";

// The sealed miniapp player: null-origin iframe (no allow-same-origin), strict CSP via sandboxDoc.
// Miniapps are usually full-window apps (html,body{height:100%;overflow:hidden}), so a short fixed
// iframe would CLIP them. Instead render at a realistic virtual window (vw×vh) and scale that iframe to
// fit — inline it fits the column width; fullscreen it fits the whole viewport so you can actually play it.
// `interactive={false}` renders a live but click-through thumbnail (no fullscreen button; the card owns
// framing + clicks), used by the Arcade grid.
//
// Capability broker: a sealed game DECLAREs `needs` (e.g. ["session-data"]). It has no network, so it speaks
// the MCP Apps `ui/*` JSON-RPC protocol (via the embedded `mcpAppClient` shim) to the trusted host. This
// component is now a thin shell over `createUiHost` (mcpUiHost.ts) — the router owns all protocol/brokering,
// single-flight guards, and staleness. The Runner keeps only the UI: the sealed iframe + scaling/fullscreen,
// the per-gem consent modal (fed to the router as the `requestConsent` callback), and the "Replay yours"
// session picker (host-initiated rebind via `host.feedSessionData`).
export function Runner({ html, vw = 1200, vh = 780, interactive = true, name, apiBase, needs }:
  { html: string; vw?: number; vh?: number; interactive?: boolean; name?: string; apiBase?: string; needs?: string[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0.5);
  const [fs, setFs] = useState(false);
  const [pending, setPending] = useState<string | null>(null); // a gated capability awaiting consent
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessions, setSessions] = useState<WatchSession[] | null>(null);
  const hostRef = useRef<UiHost | null>(null);                 // the MCP Apps router — owns protocol + brokering
  const pendingResolve = useRef<((allow: boolean) => void) | null>(null); // resolves the open requestConsent()
  const rebindBtnRef = useRef<HTMLButtonElement>(null);        // the "Replay yours" trigger — focus returns here on close
  const pickerRef = useRef<HTMLDivElement>(null);             // the picker dialog — focused on open, hosts Escape

  // Consent gate handed to the router: the router calls this for GATED caps only (AUTO caps bypass it).
  // Thumbnails never prompt/feed sensitive caps; remembered per-gem choices resolve immediately; a fresh
  // ask opens the modal and parks its resolver until Allow/Deny (decide()).
  const requestConsent = useCallback((cap: string): Promise<boolean> => {
    if (!interactive) return Promise.resolve(false);                 // thumbnails never prompt/feed sensitive caps
    if (name == null) return Promise.resolve(false);
    const decision = getConsent(name, cap);
    if (decision === "granted") return Promise.resolve(true);
    if (decision === "denied") return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {                        // ask (once)
      pendingResolve.current?.(false);                               // resolve any superseded consent prompt
      pendingResolve.current = resolve;
      setPending(cap);
      setPickerOpen(false);                                          // the ask takes precedence over an open picker
    });
  }, [interactive, name]);

  // Wire the sealed iframe to the router: create the host once its contentWindow exists and the gem declares
  // needs, delegate every `message` to host.handleMessage, and dispose (closing open streams) on teardown.
  useEffect(() => {
    if (name == null || apiBase == null || !needs?.length) return;   // apiBase="" (same-origin) is valid
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    const host = createUiHost({ apiBase, name, needs, interactive, target, requestConsent });
    hostRef.current = host;
    const onMsg = (e: MessageEvent) => host.handleMessage(e);
    window.addEventListener("message", onMsg);
    return () => { window.removeEventListener("message", onMsg); host.dispose(); hostRef.current = null; };
  }, [name, apiBase, needs, interactive, requestConsent]);

  // Close the picker and return focus to its trigger (a11y: focus must not fall to <body>).
  const closePicker = useCallback(() => { setPickerOpen(false); rebindBtnRef.current?.focus(); }, []);

  // Feed a viewer-picked session into the sealed iframe (host-initiated rebind — the sealed game can't pick
  // an arbitrary session itself). The router fetches + pushes it over the session-data notification channel.
  const feedSession = useCallback((sessionId: string, agent: string) => {
    hostRef.current?.feedSessionData(sessionId, agent);
    closePicker();
  }, [closePicker]);

  const canRebind = interactive && !!needs?.includes("session-data");
  function openPicker() {
    setPickerOpen(true);
    if (sessions == null && apiBase != null) fetchSessions(apiBase).then(setSessions).catch(() => setSessions([]));
  }
  // Move focus into the dialog when it opens so Escape works and assistive tech announces it.
  useEffect(() => { if (pickerOpen) pickerRef.current?.focus(); }, [pickerOpen]);

  // Reset the consent modal + release its parked resolver when the game changes (the host-creation effect
  // above recreates the router for the new game; open streams close via its dispose()).
  useEffect(() => {
    setPending(null);
    pendingResolve.current?.(false);
    pendingResolve.current = null;
  }, [name]);

  const decide = (allow: boolean) => {
    // Re-validate the pending cap is still one this game declared — defends the grant against any
    // future in-place name/needs swap while a prompt is open.
    if (pending == null || name == null || !needs?.includes(pending)) {
      pendingResolve.current?.(false); pendingResolve.current = null; setPending(null); return;
    }
    setConsent(name, pending, allow ? "granted" : "denied");         // remember the choice for this game
    pendingResolve.current?.(allow);                                 // resume the router's gated call
    pendingResolve.current = null;
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
      {canRebind && (
        <button ref={rebindBtnRef} onClick={openPicker} title="Replay one of your own sessions" aria-label="Replay yours"
          style={{ position: fs ? "fixed" : "absolute", top: 8, left: 8, zIndex: 1001, height: 30, padding: "0 10px",
            borderRadius: 8, border: "1px solid rgba(255,255,255,.25)", background: "rgba(20,22,28,.7)", color: "#fff",
            cursor: "pointer", font: "600 12px system-ui" }}>
          ↺ Replay yours
        </button>
      )}
      {pickerOpen && !pending && (
        <div ref={pickerRef} tabIndex={-1} className="play-consent" role="dialog" aria-modal="true" aria-label="Pick a session to replay"
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closePicker(); } }}>
          <div className="play-consent__box">
            <div className="play-consent__title">Replay one of your sessions</div>
            {sessions == null ? <div className="play-consent__sub">Loading your sessions…</div>
              : sessions.length === 0 ? <div className="play-consent__sub">No local sessions yet.</div>
              : (
                <ul className="play-src" style={{ maxHeight: 260, overflow: "auto" }}>
                  {sessions.map((s) => (
                    <li key={`${s.agent}:${s.id}`} className="play-src-row" role="button" tabIndex={0}
                      onClick={() => feedSession(s.id, s.agent)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); feedSession(s.id, s.agent); } }}>
                      <span className="play-src-row__main">{s.project ?? "session"}</span>
                      <span className="play-src-row__meta">{s.agent} · {s.msgs} msgs</span>
                    </li>
                  ))}
                </ul>
              )}
            <div className="play-consent__btns">
              <button className="play-btn" onClick={closePicker}>Close</button>
            </div>
          </div>
        </div>
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

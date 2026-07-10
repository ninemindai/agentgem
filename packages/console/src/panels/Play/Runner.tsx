// packages/console/src/panels/Play/Runner.tsx
import { useEffect, useRef, useState, useCallback } from "react";
import { sandboxDoc } from "../Watch/sandboxDoc.js";
import { fetchSessions, type WatchSession } from "../Watch/watchStream.js";
import { createUiHost, type UiHost } from "./mcpUiHost.js";
import { CAP_LABEL, getConsent, setConsent } from "./consent.js";

// The sealed miniapp player: null-origin iframe (no allow-same-origin), strict CSP via sandboxDoc.
// Miniapps are usually full-window apps (html,body{height:100%;overflow:hidden}), so a short fixed
// iframe would CLIP them. Inline, render at a realistic virtual window (vw×vh) and scale that iframe down
// to fit the column. Fullscreen instead sizes the iframe to the overlay: a miniapp lays itself out against
// its own viewport, so scaling a vw×vh frame up only magnifies it — it never plays at screen size.
// `interactive={false}` renders a live but click-through thumbnail (no fullscreen button; the card owns
// framing + clicks), used by the Arcade grid.
//
// Capability broker: a sealed game DECLAREs `needs` (e.g. ["session-data"]). It has no network, so it speaks
// the MCP Apps `ui/*` JSON-RPC protocol (via the embedded `mcpAppClient` shim) to the trusted host. This
// component is now a thin shell over `createUiHost` (mcpUiHost.ts) — the router owns all protocol/brokering,
// single-flight guards, and staleness. The Runner keeps only the UI: the sealed iframe + scaling/fullscreen,
// the per-gem consent modal (fed to the router as the `requestConsent` callback), and the "Replay yours"
// session picker (host-initiated rebind via `host.feedSessionData`).
// maxHeight: an inline height budget (px). Without it the inline game is sized by width alone, so on a
// wide, short screen it grows tall enough to push the studio composer below the fold.
export function Runner({ html, vw = 1200, vh = 780, interactive = true, name, apiBase, needs, maxHeight }:
  { html: string; vw?: number; vh?: number; interactive?: boolean; name?: string; apiBase?: string; needs?: string[]; maxHeight?: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0.5);
  const [fs, setFs] = useState(false);
  const [pending, setPending] = useState<string | null>(null); // a gated capability awaiting consent
  const [pendingDetail, setPendingDetail] = useState<string | undefined>(undefined); // extra context for the prompt (e.g. open-link's URL)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessions, setSessions] = useState<WatchSession[] | null>(null);
  const hostRef = useRef<UiHost | null>(null);                 // the MCP Apps router — owns protocol + brokering
  const pendingResolve = useRef<((allow: boolean) => void) | null>(null); // resolves the open requestConsent()
  const rebindBtnRef = useRef<HTMLButtonElement>(null);        // the "Replay yours" trigger — focus returns here on close
  const pickerRef = useRef<HTMLDivElement>(null);             // the picker dialog — focused on open, hosts Escape

  // Consent gate handed to the router: the router calls this for GATED caps only (AUTO caps bypass it).
  // Thumbnails never prompt/feed sensitive caps; remembered per-gem choices resolve immediately; a fresh
  // ask opens the modal and parks its resolver until Allow/Deny (decide()).
  // open-link is special: it always shows the URL (`detail`) and is NEVER remembered — every call prompts
  // fresh, unlike the cache-backed behavior every other gated cap gets.
  const requestConsent = useCallback((cap: string, detail?: string): Promise<boolean> => {
    if (!interactive) return Promise.resolve(false);                 // thumbnails never prompt/feed sensitive caps
    if (name == null) return Promise.resolve(false);
    if (cap !== "open-link") {
      const decision = getConsent(name, cap);
      if (decision === "granted") return Promise.resolve(true);
      if (decision === "denied") return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {                        // ask (once)
      pendingResolve.current?.(false);                               // resolve any superseded consent prompt
      pendingResolve.current = resolve;
      setPending(cap);
      setPendingDetail(detail);
      setPickerOpen(false);                                          // the ask takes precedence over an open picker
    });
  }, [interactive, name]);

  // The live host context sent on ui/initialize and re-pushed on every fullscreen toggle. Colors must
  // resolve to concrete hex here: the sealed iframe has no `allow-same-origin`, so it can't see the
  // console's stylesheet — a `var(--paper)` reference would be inert inside it. Fallbacks are theme.css's
  // current values (shell/theme.css) so a resolve failure still yields a real theme instead of unset vars.
  const hostContext = useCallback(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (name_: string, fb: string) => cs.getPropertyValue(name_).trim() || fb;
    return {
      theme: "light",
      styles: { variables: {
        "--color-background-primary": v("--paper", "#f1eadb"),
        "--color-background-secondary": v("--paper-2", "#e9e0cd"),
        "--color-text-primary": v("--ink", "#20190f"),
        "--color-border-primary": v("--line", "#ddd0b7"),
      } },
      displayMode: fs ? "fullscreen" : "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { width: vw, height: vh },
    };
  }, [fs, vw, vh]);

  // Wire the sealed iframe to the router: create the host once its contentWindow exists and the gem declares
  // needs, delegate every `message` to host.handleMessage, and invalidate it on teardown. The iframe has no
  // `key`, so React reuses the same contentWindow across a game switch — bumpGeneration() (not dispose())
  // is required here: it closes streams AND advances `generation`, so any in-flight continuation from the
  // old game (e.g. a one-shot session-data fetch) sees `stale(gen)` and drops its reply instead of posting
  // stale data into the new game's iframe.
  useEffect(() => {
    if (name == null || apiBase == null || !needs?.length) return;   // apiBase="" (same-origin) is valid
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    const host = createUiHost({
      apiBase, name, needs, interactive, target, requestConsent, hostContext,
      onDisplayMode: (m) => { const ok = interactive && m === "fullscreen"; setFs(ok); return ok ? "fullscreen" : "inline"; },
      openExternal: (url) => { window.open(url, "_blank", "noopener"); },
    });
    hostRef.current = host;
    const onMsg = (e: MessageEvent) => host.handleMessage(e);
    window.addEventListener("message", onMsg);
    return () => { window.removeEventListener("message", onMsg); host.bumpGeneration(); hostRef.current = null; };
  }, [name, apiBase, needs, interactive, requestConsent, hostContext]);

  // Push host-context-changed on every fullscreen toggle, whether button- or request-driven, so the game
  // re-lays-out from the new dimensions instead of scaling a magnified vw×vh. Skip the very first render
  // (host doesn't exist yet / nothing has changed to announce) via the mounted ref below.
  const fsMounted = useRef(false);
  useEffect(() => {
    if (!fsMounted.current) { fsMounted.current = true; return; }
    hostRef.current?.pushHostContext({
      displayMode: fs ? "fullscreen" : "inline",
      containerDimensions: fs ? { width: window.innerWidth, height: window.innerHeight } : { width: vw, height: vh },
    });
  }, [fs, vw, vh]);

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
    setPendingDetail(undefined);
    pendingResolve.current?.(false);
    pendingResolve.current = null;
  }, [name]);

  const decide = (allow: boolean) => {
    // Re-validate the pending cap is still one this game declared — defends the grant against any
    // future in-place name/needs swap while a prompt is open.
    if (pending == null || name == null || !needs?.includes(pending)) {
      pendingResolve.current?.(false); pendingResolve.current = null; setPending(null); setPendingDetail(undefined); return;
    }
    // open-link is never remembered — every call re-prompts, so don't cache a grant/denial for it.
    if (pending !== "open-link") setConsent(name, pending, allow ? "granted" : "denied");
    pendingResolve.current?.(allow);                                 // resume the router's gated call
    pendingResolve.current = null;
    setPending(null);
    setPendingDetail(undefined);
  };

  // Inline only: fit the column width and any height budget, never upscale. Fullscreen needs no scale — the
  // iframe is sized to the overlay itself, so the miniapp lays out against the real screen instead of a
  // magnified vw×vh.
  useEffect(() => {
    const box = boxRef.current;
    if (fs || !box || typeof ResizeObserver === "undefined") return; // jsdom / non-browser: keep the default
    const measure = () =>
      setScale(Math.min(1, (box.clientWidth || vw) / vw, ...(maxHeight ? [maxHeight / vh] : [])));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [vw, vh, fs, maxHeight]);

  const boxStyle: React.CSSProperties = fs
    ? { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(12,14,18,.94)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }
    : interactive
      // Once maxHeight can make the scale height-bound, the game is narrower than the box — so centre it.
      // background is the paper mat, not #fff: when the scale is height-bound the game is pillarboxed,
      // and the gap should read as part of the mount rather than as a white seam.
      ? { position: "relative", width: "100%", height: Math.round(vh * scale), overflow: "hidden", border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper-2)",
          display: "flex", justifyContent: "center" }
      : { position: "absolute", inset: 0, overflow: "hidden", background: "#0d1117" }; // thumbnail: fill the card slot

  return (
    <div ref={boxRef} style={boxStyle}>
      <iframe
        ref={iframeRef}
        title="miniapp preview"
        sandbox="allow-scripts"
        srcDoc={sandboxDoc(html)}
        // flexShrink:0 — the inline iframe's layout box must stay vw wide, or the flex row would shrink it
        // and the scale factor would no longer describe the rendered size.
        style={fs
          ? { width: "100%", height: "100%", border: 0, display: "block", background: "#0d1117" }
          : { width: vw, height: vh, border: 0, display: "block", background: "#fff", pointerEvents: interactive ? "auto" : "none", flexShrink: 0,
              transform: `scale(${scale})`, transformOrigin: interactive ? "top center" : "top left" }}
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
            {pending === "open-link" && pendingDetail && (
              <div className="play-consent__sub"><code>{pendingDetail}</code></div>
            )}
            <div className="play-consent__sub">
              {pending === "open-link"
                ? "The game stays sealed (no network of its own) — the host feeds this in only if you allow. Asked every time."
                : "The game stays sealed (no network of its own) — the host feeds this in only if you allow. Remembered for this game."}
            </div>
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

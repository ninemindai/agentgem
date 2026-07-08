// packages/console/src/panels/Play/Runner.tsx
import { useEffect, useRef, useState, useCallback } from "react";
import { sandboxDoc } from "../Watch/sandboxDoc.js";
import { makeClient, playSessionDataRoute, inventoryRoute } from "../../api/routes.js";
import { fetchSessions, openWatchStream, type WatchSession } from "../Watch/watchStream.js";
import { openStudioStream } from "./studioStream.js";
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessions, setSessions] = useState<WatchSession[] | null>(null);
  const pendingMsg = useRef<string | undefined>(undefined);     // the invoke-agent message that triggered the prompt
  const teardown = useRef<(() => void)[]>([]);                  // live streams to close on unmount / game change
  const liveOpen = useRef(false);                               // one live-session-events stream per game
  const chatId = useRef<string | null>(null);                  // reused invoke-agent chat session
  const chatPromise = useRef<Promise<string> | null>(null);    // in-flight chat-open (serialize concurrent invokes)
  const invoking = useRef(false);                              // one invoke-agent turn at a time
  const gameGen = useRef(0);                                   // bumped per game; async continuations pin to it

  // Serve a capability into the sealed iframe. One-shot caps fetch+feed once; streaming caps
  // (live-session-events, invoke-agent) open a stream and forward each event, registering a teardown.
  const serve = useCallback(async (cap: string, message?: string): Promise<void> => {
    if (name == null || apiBase == null) return;
    const gen = gameGen.current;                                 // pin this serve to the current game
    const stale = () => gen !== gameGen.current;                 // game changed while we were awaiting
    const client = makeClient(apiBase);
    const post = (data: unknown) => { if (!stale()) iframeRef.current?.contentWindow?.postMessage({ type: "agentgem:feed", channel: cap, data }, "*"); };
    const register = (close: () => void) => { if (stale()) { try { close(); } catch { /* ignore */ } } else teardown.current.push(close); };
    try {
      if (cap === "session-data") { post(await playSessionDataRoute.call(client, { query: { name } })); return; }
      if (cap === "local-project-access") { post(await inventoryRoute.call(client)); return; }
      if (cap === "live-session-events") {
        if (liveOpen.current) return;                            // idempotent — one live stream per game
        liveOpen.current = true;
        try {
          const sessions = await fetchSessions(apiBase);
          const file = sessions[0]?.file;                        // the most-recent session = "live"
          if (!file) { post({ type: "idle" }); liveOpen.current = false; return; } // allow a later retry once a session exists
          register(openWatchStream(apiBase, file, (ev) => post(ev)));
        } catch (e) { liveOpen.current = false; throw e; }       // release the guard so a retry can succeed
        return;
      }
      if (cap === "invoke-agent") {
        if (!message || invoking.current) return;                // each invoke carries a prompt; one turn at a time
        if (!chatId.current) {
          // Serialize chat-open so two fast invokes don't spawn two sessions (check-then-set race).
          if (!chatPromise.current) chatPromise.current = (async () => {
            const agents = await fetch(`${apiBase}/api/agents`).then((r) => r.json());
            const agentId = agents.agents?.find((a: { available?: boolean }) => a.available)?.id ?? agents.agents?.[0]?.id;
            const res = await fetch(`${apiBase}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId }) }).then((r) => r.json());
            return res.chatId as string;                         // neutral (read-only, permission:deny) — no miniapp
          })();
          chatId.current = await chatPromise.current;
        }
        if (stale()) return;
        invoking.current = true;
        register(openStudioStream(apiBase, chatId.current, message, {
          onDelta: (text) => post({ kind: "delta", text }),
          onTool: (tool) => post({ kind: "tool", tool }),
          onDone: () => { invoking.current = false; post({ kind: "done" }); },
          onFailed: (error) => { invoking.current = false; post({ kind: "failed", error }); },
        }));
        return;
      }
    } catch { /* no host data — the game shows its waiting/failed state */ }
  }, [name, apiBase]);

  // Feed a viewer-picked session into the sealed iframe on the session-data channel (the scaffold
  // re-renders on it). Reuses the serve() staleness guard shape; the picked ref is host-owned.
  const feedSession = useCallback(async (sessionId: string, agent: string) => {
    if (name == null || apiBase == null) return;
    const gen = gameGen.current;
    try {
      const data = await playSessionDataRoute.call(makeClient(apiBase), { query: { name, sessionId, agent } });
      if (gen === gameGen.current) iframeRef.current?.contentWindow?.postMessage({ type: "agentgem:feed", channel: "session-data", data }, "*");
    } catch { /* keep the current render */ }
    setPickerOpen(false);
  }, [name, apiBase]);

  const canRebind = interactive && !!needs?.includes("session-data");
  function openPicker() {
    setPickerOpen(true);
    if (sessions == null && apiBase != null) fetchSessions(apiBase).then(setSessions).catch(() => setSessions([]));
  }

  // Capability broker + consent gate. The sealed game (no network) postMessages a request; we honor only
  // requests from THIS iframe and only a `want` the gem declared in `needs`. AUTO caps serve immediately;
  // gated caps require remembered per-gem consent (prompt on first ask). Thumbnails never prompt.
  useEffect(() => {
    if (name == null || apiBase == null || !needs?.length) return; // apiBase="" (same-origin) is valid
    const onMsg = (e: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win || e.source !== win) return;                            // only our own sealed iframe
      const d = e.data as { type?: string; want?: string; message?: string } | null;
      if (!d || d.type !== "agentgem:request" || !d.want || !needs.includes(d.want)) return; // only declared caps
      const cap = d.want, message = typeof d.message === "string" ? d.message : undefined;
      if (AUTO_CAPS.has(cap)) { void serve(cap, message); return; }
      if (!interactive) return;                                        // thumbnails never prompt/feed sensitive caps
      const decision = getConsent(name, cap);
      if (decision === "granted") void serve(cap, message);
      else if (decision === null) { pendingMsg.current = message; setPending(cap); } // ask (once)
      // "denied" → silently ignore
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [name, apiBase, needs, interactive, serve]);

  // Close any open streams + reset session refs when the game changes or the Runner unmounts.
  useEffect(() => {
    setPending(null);
    return () => { teardown.current.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); teardown.current = []; liveOpen.current = false; chatId.current = null; };
  }, [name]);

  const decide = (allow: boolean) => {
    // Re-validate the pending cap is still one this game declared — defends the grant against any
    // future in-place name/needs swap while a prompt is open.
    if (pending == null || name == null || !needs?.includes(pending)) { setPending(null); return; }
    setConsent(name, pending, allow ? "granted" : "denied");
    if (allow) void serve(pending, pendingMsg.current);
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
        <button onClick={openPicker} title="Replay one of your own sessions" aria-label="Replay yours"
          style={{ position: fs ? "fixed" : "absolute", top: 8, left: 8, zIndex: 1001, height: 30, padding: "0 10px",
            borderRadius: 8, border: "1px solid rgba(255,255,255,.25)", background: "rgba(20,22,28,.7)", color: "#fff",
            cursor: "pointer", font: "600 12px system-ui" }}>
          ↺ Replay yours
        </button>
      )}
      {pickerOpen && (
        <div className="play-consent" role="dialog" aria-label="Pick a session to replay">
          <div className="play-consent__box">
            <div className="play-consent__title">Replay one of your sessions</div>
            {sessions == null ? <div className="play-consent__sub">Loading your sessions…</div>
              : sessions.length === 0 ? <div className="play-consent__sub">No local sessions yet.</div>
              : (
                <ul className="play-src" style={{ maxHeight: 260, overflow: "auto" }}>
                  {sessions.map((s) => (
                    <li key={`${s.agent}:${s.id}`} className="play-src-row" onClick={() => feedSession(s.id, s.agent)}>
                      <span className="play-src-row__main">{s.project ?? "session"}</span>
                      <span className="play-src-row__meta">{s.agent} · {s.msgs} msgs</span>
                    </li>
                  ))}
                </ul>
              )}
            <div className="play-consent__btns">
              <button className="play-btn" onClick={() => setPickerOpen(false)}>Close</button>
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

// packages/console/src/panels/Play/Studio.tsx
import { useEffect, useRef, useState } from "react";
import { makeClient, playMiniappRoute, playSaveRoute, playPublishRoute, publishSetupRoute, bindStatusRoute } from "../../api/routes.js";
import { AgentSelector, type PlayAgent } from "./AgentSelector.js";
import { Runner } from "./Runner.js";
import { openStudioStream } from "./studioStream.js";
import { genre as genreOf, parseGateFailure, fixSealPrompt } from "./playMeta.js";

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };

// Structured chat log entries so we can render bubbles + tool chips instead of one rolling string.
type Msg = { role: "user" | "agent"; text: string } | { role: "tool"; title: string; failed?: boolean };

export function Studio({
  apiBase,
  name,
  seedPrompt,
  agents,
  agentId,
  onAgentIdChange,
  onBack,
}: {
  apiBase: string;
  name: string;
  // When a blank miniapp was created with a description, it's auto-sent as the first build prompt.
  seedPrompt?: string;
  agents: PlayAgent[] | null;
  agentId: string;
  onAgentIdChange: (agentId: string) => void;
  onBack: () => void;
}) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState("");
  const [html, setHtml] = useState("");
  const [meta, setMeta] = useState<{ title: string; genre: string; needs?: string[] } | null>(null);
  const [status, setStatus] = useState("");
  const [gate, setGate] = useState<string[] | null>(null);       // seal failures → actionable banner
  const [share, setShare] = useState<{ gemUrl: string; cardUrl?: string } | null>(null);
  const closeRef = useRef<null | (() => void)>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [plateMax, setPlateMax] = useState<number | undefined>(undefined);
  const seededRef = useRef(false);   // guards the one-shot seed-prompt auto-send

  const refresh = () =>
    playMiniappRoute.call(makeClient(apiBase), { query: { name } })
      .then((r) => { setHtml(r.html); setMeta(r.meta); }).catch(() => {});

  useEffect(() => {
    refresh();
    return () => closeRef.current?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, name]);

  // Kick off the build from the blank-tab description: send it as the first chat message, once an agent
  // is ready. One-shot (seededRef) so it never re-fires when the agent list resolves or agent changes.
  useEffect(() => {
    if (seededRef.current || !seedPrompt || !agentId) return;
    seededRef.current = true;
    send(seedPrompt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedPrompt, agentId]);

  useEffect(() => { logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight }); }, [msgs, working]); // scrollTo absent in jsdom

  // Grow the composer with its content, up to the max-height at which CSS makes it scroll. Reset to
  // auto first, else scrollHeight only ever reports the taller of (content, current height).
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !el.scrollHeight) return;   // jsdom reports 0
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Budget the preview's height so the composer always stays on the first screen: whatever is left
  // between the top of the plate and the composer (which grows as you type). Re-measured on resize,
  // on composer growth, and whenever a banner shifts the plate down.
  useEffect(() => {
    const calc = () => {
      const top = plateRef.current?.getBoundingClientRect().top;
      if (top == null) return;
      const reserve = (composerRef.current?.offsetHeight ?? 120) + 40;  // composer + its margin + breathing room
      setPlateMax(Math.max(240, Math.round(window.innerHeight - top - reserve - 16))); // 16 = plate padding + border
    };
    calc();
    window.addEventListener("resize", calc);
    const ro = typeof ResizeObserver !== "undefined" && composerRef.current ? new ResizeObserver(calc) : null;
    if (composerRef.current) ro?.observe(composerRef.current);
    return () => { window.removeEventListener("resize", calc); ro?.disconnect(); };
  }, [gate, share]);

  function pushDelta(t: string) {
    setMsgs((m) => {
      const last = m[m.length - 1];
      if (last && last.role === "agent") return [...m.slice(0, -1), { role: "agent", text: last.text + t }];
      return [...m, { role: "agent", text: t }];
    });
  }
  function activity(tool: { kind?: string; title?: string }): string {
    switch (tool.kind) { case "execute": return "running a command…"; case "read": return "reading files…"; case "edit": return "editing the miniapp…"; default: return "working…"; }
  }

  function changeAgent(nextAgentId: string) {
    if (nextAgentId === agentId) return;
    closeRef.current?.();
    closeRef.current = null;
    setChatId(null);
    setMsgs([]);
    setWorking("");
    setGate(null);
    setShare(null);
    setStatus(chatId ? "switched coding agent; next message starts a new studio chat" : "");
    onAgentIdChange(nextAgentId);
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy || !agentId) return;
    setBusy(true); setWorking("thinking…"); setGate(null); setShare(null);
    setMsgs((m) => [...m, { role: "user", text: message }]);
    try {
      let id = chatId;
      if (!id) {
        const res = await fetch(`${apiBase}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId, miniapp: name }) }).then(j);
        id = res.chatId as string; setChatId(id);
      }
      closeRef.current = openStudioStream(apiBase, id, message, {
        onDelta: (t) => { setWorking("responding…"); pushDelta(t); },
        onTool: (tool) => { setWorking(activity(tool)); setMsgs((m) => [...m, { role: "tool", title: tool.title ?? tool.kind ?? "tool", failed: tool.status === "failed" }]); },
        onDone: async () => { setBusy(false); setWorking(""); await refresh(); },
        onFailed: (e) => { setBusy(false); setWorking(""); setMsgs((m) => [...m, { role: "tool", title: `failed: ${e}`, failed: true }]); },
      });
    } catch (e) { setBusy(false); setWorking(""); setStatus(`error: ${(e as Error).message}`); }
  }

  function submit() { send(input); setInput(""); }

  // Save gates the seal; a gate failure becomes an actionable banner (offer to have the agent fix it).
  async function save(): Promise<boolean> {
    setStatus("saving…"); setGate(null);
    try {
      const cur = await playMiniappRoute.call(makeClient(apiBase), { query: { name } });
      await playSaveRoute.call(makeClient(apiBase), { body: { name, html: cur.html, meta: {
        title: cur.meta.title, genre: cur.meta.genre as "replay" | "skill-run" | "project-fun",
        createdFrom: cur.meta.createdFrom, engineVersion: cur.meta.engineVersion,
        ...(cur.meta.needs ? { needs: cur.meta.needs } : {}),
      } } });
      setStatus("saved ✓"); return true;
    } catch (e) {
      const failures = parseGateFailure((e as Error).message);
      if (failures) { setGate(failures); setStatus(""); } else setStatus(`save failed: ${(e as Error).message}`);
      return false;
    }
  }

  async function pushGit() {
    setStatus("pushing…");
    try { await playPublishRoute.call(makeClient(apiBase), { body: {} }); setStatus("pushed to git ✓"); }
    catch (e) { setStatus(`push failed: ${(e as Error).message}`); }
  }

  // Share to Explore (app.agentgem.ai): Save (creates the game-gem workspace + enforces the seal), then
  // publish that workspace via the same funnel other gems use. Gated on a GitHub bind.
  async function shareToExplore() {
    setStatus("preparing…"); setShare(null);
    if (!(await save())) return; // gate failure already surfaced as the banner
    try {
      const client = makeClient(apiBase);
      const bind = await bindStatusRoute.call(client);
      if (!bind.bound || !bind.login) { setStatus("Connect your GitHub in Curate to publish publicly."); return; }
      setStatus("publishing to app.agentgem.ai…");
      const g = genreOf(meta?.genre ?? "project-fun");
      const pub = await publishSetupRoute.call(client, { body: {
        workspace: name, scope: bind.login, name, version: "0.1.0", provenance: "play",
        description: `${g.label} mini-game`, tags: ["game", meta?.genre ?? "project-fun"],
      } });
      // Link the gem's marketplace page (installable / playable), not just the OG teaser card.
      setShare({ gemUrl: `https://app.agentgem.ai/gems/${encodeURIComponent(pub.exploreRef)}`, cardUrl: pub.shareUrl }); setStatus("");
    } catch (e) {
      const body = (e as Record<string, unknown>).body;
      setStatus(`share failed: ${typeof body === "string" ? body : (e as Error).message}`);
    }
  }

  const g = genreOf(meta?.genre ?? "");
  return (
    <section className="analyze">
      <div className="play-studio-head">
        <button className="play-btn play-btn--ghost" onClick={onBack}>← Arcade</button>
        <span className="play-studio-title">{meta?.title ?? name}</span>
        <span className="play-pill"><span className="play-pill__dot" style={{ background: g.tint }} />{g.icon} {g.label}</span>
        <span className="sp" />
        {status && <span className="play-intro" style={{ margin: 0 }}>{status}</span>}
        <button className="play-btn" onClick={save}>Save</button>
        <button className="play-btn play-btn--ghost" onClick={pushGit} title="git push the miniapps registry to your git remote">Push to git</button>
        <button className="play-btn play-btn--primary" onClick={shareToExplore}>Share to app.agentgem.ai</button>
      </div>

      {share && (
        <div className="play-banner play-banner--ok">
          <span className="play-banner__ico">🌐</span>
          <div className="play-banner__body">
            <div className="play-banner__title">Published to app.agentgem.ai</div>
            <div className="play-banner__detail">{share.gemUrl}{share.cardUrl ? ` · share card: ${share.cardUrl}` : ""}</div>
          </div>
          <button className="play-btn" onClick={() => navigator.clipboard?.writeText(share.gemUrl)}>Copy</button>
          <button className="play-btn play-btn--ghost" onClick={() => window.open(share.gemUrl, "_blank", "noopener")}>Open</button>
        </div>
      )}
      {gate && (
        <div className="play-banner">
          <span className="play-banner__ico">🔒</span>
          <div className="play-banner__body">
            <div className="play-banner__title">Not sealed yet — can't save</div>
            <div className="play-banner__detail">{gate.join("; ")}</div>
          </div>
          <button className="play-btn play-btn--primary" disabled={busy} onClick={() => { const f = gate; setGate(null); send(fixSealPrompt(f)); }}>Fix with agent</button>
        </div>
      )}

      <AgentSelector
        agents={agents}
        agentId={agentId}
        disabled={busy}
        onChange={changeAgent}
        note={chatId ? "Changing agent starts a fresh studio chat." : "This agent will build/edit the miniapp."}
      />

      <div className="play-grid-2">
        <div className="play-stage">
          <div className="play-cap-row"><span className="play-cap">Preview</span><span className="play-cap__rule" /></div>
          <div className="play-plate" ref={plateRef}><Runner html={html} name={name} apiBase={apiBase} needs={meta?.needs} maxHeight={plateMax} /></div>
        </div>
        <div className="play-chat">
          <div className="play-cap-row"><span className="play-cap">Studio chat</span><span className="play-cap__rule" /></div>
          <div className="play-log" ref={logRef}>
            {msgs.length === 0 && (
              <div className="play-log__empty">
                <b>Nothing built yet</b>
                <span>Describe a change below and the agent will edit the miniapp in place.</span>
              </div>
            )}
            {msgs.map((m, i) => m.role === "tool"
              ? <div key={i} className={`play-tool${m.failed ? " is-failed" : ""}`}>🔧 <b>{m.title}</b></div>
              : <div key={i} className={`play-msg play-msg--${m.role}`}>{m.text}</div>)}
            {busy && <div className="studio-thinking"><span className="dots"><i /><i /><i /></span><span>{working || "working…"}</span></div>}
          </div>
        </div>
      </div>

      <div className="play-composer-in" ref={composerRef}>
        <textarea ref={inputRef} className="play-input play-input--chat" rows={3}
          placeholder="ask the agent to build/edit the miniapp…" value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
        <div className="play-composer-foot">
          <span className="play-composer-hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</span>
          <button className="play-btn play-btn--primary" disabled={busy || !input.trim() || !agentId} onClick={submit}>{busy ? "…" : "Send"}</button>
        </div>
      </div>
    </section>
  );
}

// packages/console/src/panels/Play/Studio.tsx
import { useEffect, useRef, useState } from "react";
import { makeClient, playMiniappRoute, playSaveRoute, playPublishRoute, publishSetupRoute, bindStatusRoute } from "../../api/routes.js";
import { Runner } from "./Runner.js";
import { openStudioStream } from "./studioStream.js";
import { genre as genreOf, parseGateFailure, fixSealPrompt } from "./playMeta.js";

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };

// Structured chat log entries so we can render bubbles + tool chips instead of one rolling string.
type Msg = { role: "user" | "agent"; text: string } | { role: "tool"; title: string; failed?: boolean };

export function Studio({ apiBase, name, onBack }: { apiBase: string; name: string; onBack: () => void }) {
  const [agentId, setAgentId] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState("");
  const [html, setHtml] = useState("");
  const [meta, setMeta] = useState<{ title: string; genre: string; needs?: string[] } | null>(null);
  const [status, setStatus] = useState("");
  const [gate, setGate] = useState<string[] | null>(null);       // seal failures → actionable banner
  const [share, setShare] = useState<{ url: string } | null>(null);
  const closeRef = useRef<null | (() => void)>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = () =>
    playMiniappRoute.call(makeClient(apiBase), { query: { name } })
      .then((r) => { setHtml(r.html); setMeta(r.meta); }).catch(() => {});

  useEffect(() => {
    fetch(`${apiBase}/api/agents`).then(j).then((d: { agents: { id: string; available: boolean }[] }) => {
      setAgentId(d.agents.find((a) => a.available)?.id ?? d.agents[0]?.id ?? "");
    }).catch(() => {});
    refresh();
    return () => closeRef.current?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, name]);

  useEffect(() => { logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight }); }, [msgs, working]); // scrollTo absent in jsdom

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
      if (!bind.bound || !bind.login) { setStatus("Connect your GitHub (Curate → Publish to Explore) to share publicly."); return; }
      setStatus("publishing to Explore…");
      const g = genreOf(meta?.genre ?? "project-fun");
      const pub = await publishSetupRoute.call(client, { body: {
        workspace: name, scope: bind.login, name, version: "0.1.0", provenance: "play",
        description: `${g.label} mini-game`, tags: ["game", meta?.genre ?? "project-fun"],
      } });
      setShare({ url: pub.shareUrl }); setStatus("");
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
        <button className="play-btn play-btn--primary" onClick={shareToExplore}>Share to Explore</button>
      </div>

      {share && (
        <div className="play-banner play-banner--ok">
          <span className="play-banner__ico">🌐</span>
          <div className="play-banner__body">
            <div className="play-banner__title">Published to Explore</div>
            <div className="play-banner__detail">{share.url}</div>
          </div>
          <button className="play-btn" onClick={() => navigator.clipboard?.writeText(share.url)}>Copy</button>
          <button className="play-btn play-btn--ghost" onClick={() => window.open(share.url, "_blank", "noopener")}>Open</button>
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

      <div className="play-grid-2">
        <Runner html={html} name={name} apiBase={apiBase} needs={meta?.needs} />
        <div className="play-chat">
          <div className="play-log" ref={logRef}>
            {msgs.length === 0 && <div className="play-log__hint">Ask the agent to build or change the miniapp…</div>}
            {msgs.map((m, i) => m.role === "tool"
              ? <div key={i} className={`play-tool${m.failed ? " is-failed" : ""}`}>🔧 <b>{m.title}</b></div>
              : <div key={i} className={`play-msg play-msg--${m.role}`}>{m.text}</div>)}
            {busy && <div className="studio-thinking"><span className="dots"><i /><i /><i /></span><span>{working || "working…"}</span></div>}
          </div>
          <div className="play-composer-in">
            <input className="play-input" placeholder="ask the agent to build/edit…" value={input}
              onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { send(input); setInput(""); } }} />
            <button className="play-btn play-btn--primary" disabled={busy} onClick={() => { send(input); setInput(""); }}>{busy ? "…" : "Send"}</button>
          </div>
        </div>
      </div>
    </section>
  );
}

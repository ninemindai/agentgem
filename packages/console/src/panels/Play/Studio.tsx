// packages/console/src/panels/Play/Studio.tsx
import { useEffect, useRef, useState } from "react";
import { makeClient, playMiniappRoute, playSaveRoute, playPublishRoute } from "../../api/routes.js";
import { Runner } from "./Runner.js";
import { openStudioStream } from "./studioStream.js";

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };

export function Studio({ apiBase, name, onBack }: { apiBase: string; name: string; onBack: () => void }) {
  const [agentId, setAgentId] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [log, setLog] = useState("");        // rolling agent output
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(""); // live activity label while a turn is in flight
  const [html, setHtml] = useState("");      // live preview source
  const [meta, setMeta] = useState<{ title: string; genre: string } | null>(null);
  const [status, setStatus] = useState("");
  const closeRef = useRef<null | (() => void)>(null);

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

  // Short human label for the current activity, so the indicator says what the agent is doing.
  function activity(tool: { kind?: string; title?: string }): string {
    switch (tool.kind) {
      case "execute": return "running a command…";
      case "read": return "reading files…";
      case "edit": return "editing the miniapp…";
      default: return "working…";
    }
  }

  async function send() {
    if (!input.trim() || busy || !agentId) return;
    setBusy(true); setWorking("thinking…"); setLog((l) => l + `\n\n> ${input}\n`);
    try {
      let id = chatId;
      if (!id) {
        const res = await fetch(`${apiBase}/api/chat`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId, miniapp: name }),  // studio mode (Plan 2b)
        }).then(j);
        id = res.chatId as string; setChatId(id);
      }
      const message = input; setInput("");
      closeRef.current = openStudioStream(apiBase, id, message, {
        onDelta: (t) => { setWorking("responding…"); setLog((l) => l + t); },
        onTool: (tool) => { setWorking(activity(tool)); setLog((l) => l + `\n🔧 ${tool.title ?? tool.kind ?? "tool"}${tool.status === "failed" ? " (failed)" : ""}\n`); },
        onDone: async () => { setBusy(false); setWorking(""); await refresh(); },  // live preview updates as the agent edits
        onFailed: (e) => { setBusy(false); setWorking(""); setStatus(`error: ${e}`); },
      });
    } catch (e) { setBusy(false); setStatus(`error: ${(e as Error).message}`); }
  }

  async function save() {
    setStatus("saving…");
    try {
      const cur = await playMiniappRoute.call(makeClient(apiBase), { query: { name } });
      // Echo the REAL provenance/version fetched from disk — save() persists meta.json, so a placeholder
      // would silently corrupt createdFrom on every save.
      await playSaveRoute.call(makeClient(apiBase), { body: { name, html: cur.html, meta: {
        title: cur.meta.title, genre: cur.meta.genre as "replay" | "skill-run" | "project-fun",
        createdFrom: cur.meta.createdFrom, engineVersion: cur.meta.engineVersion,
        ...(cur.meta.needs ? { needs: cur.meta.needs } : {}),
      } } });
      setStatus("saved ✓");
    } catch (e) { setStatus(`save failed: ${(e as Error).message}`); }
  }

  async function publish() {
    setStatus("publishing…");
    try { await playPublishRoute.call(makeClient(apiBase), { body: {} }); setStatus("published ✓"); }
    catch (e) { setStatus(`publish failed: ${(e as Error).message}`); }
  }

  return (
    <section className="analyze">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <button className="ledger-search" style={{ width: "auto" }} onClick={onBack}>← arcade</button>
        <strong>{meta?.title ?? name}</strong>
        <span style={{ opacity: 0.6, fontSize: 12 }}>{meta?.genre}</span>
        <span style={{ flex: 1 }} />
        <button className="run-badge" onClick={save}>Save</button>
        <button className="run-badge" onClick={publish}>Publish</button>
        {status && <span className="run-status" style={{ marginLeft: 8 }}>{status}</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) minmax(300px, 1fr)", gap: 12, alignItems: "start" }}>
        <Runner html={html} />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <pre className="ledger-view" style={{ height: 360, overflow: "auto", whiteSpace: "pre-wrap", margin: 0 }}>{log || "Ask the agent to build or change the miniapp…"}</pre>
          {busy && (
            <div className="studio-thinking">
              <span className="dots"><i /><i /><i /></span>
              <span>{working || "working…"}</span>
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <input className="ledger-search" style={{ flex: 1, marginBottom: 0 }} placeholder="ask the agent to build/edit…"
              value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
            <button className="run-badge run-running" disabled={busy} onClick={send}>{busy ? "…" : "Send"}</button>
          </div>
        </div>
      </div>
    </section>
  );
}

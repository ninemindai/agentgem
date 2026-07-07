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

  async function send() {
    if (!input.trim() || busy || !agentId) return;
    setBusy(true); setLog((l) => l + `\n\n> ${input}\n`);
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
        onDelta: (t) => setLog((l) => l + t),
        onDone: async () => { setBusy(false); await refresh(); },  // live preview updates
        onFailed: (e) => { setBusy(false); setStatus(`error: ${e}`); },
      });
    } catch (e) { setBusy(false); setStatus(`error: ${(e as Error).message}`); }
  }

  async function save() {
    setStatus("saving…");
    try {
      const cur = await playMiniappRoute.call(makeClient(apiBase), { query: { name } });
      await playSaveRoute.call(makeClient(apiBase), { body: { name, html: cur.html, meta: {
        title: cur.meta.title, genre: cur.meta.genre as "replay" | "skill-run" | "project-fun",
        createdFrom: { kind: "project", path: "", flavor: "" }, engineVersion: "1",
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Runner html={html} height={420} />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <pre className="ledger-view" style={{ height: 360, overflow: "auto", whiteSpace: "pre-wrap", margin: 0 }}>{log || "Ask the agent to build or change the miniapp…"}</pre>
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

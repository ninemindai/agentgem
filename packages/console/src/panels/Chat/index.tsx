import { useEffect, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { openChatStream, type ChatToolChip } from "./chatStream.js";
import { ScopePicker, type Scope } from "../_shared/ScopePicker.js";

interface Agent {
  id: string;
  name: string;
  description?: string;
  available: boolean;
  installable?: boolean;
  source?: string;
}

interface Message {
  role: "user" | "assistant";
  text: string;
  tools: ChatToolChip[];
  streaming: boolean;
}

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };

export function Chat({ apiBase }: { apiBase: string }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agentId, setAgentId] = useState<string>("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [launch, setLaunch] = useState<Scope>({ kind: "global" });
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Messages typed while a turn is in flight (2026-07-20 queue design). State renders the chips; the
  // ref is the logic's copy so fireQueued never runs a send inside a state updater. chatIdRef keeps
  // callbacks from earlier renders (a turn's onDone) on the LIVE session — the stale state would
  // silently fork a second chat for the queued flush.
  const [queued, setQueued] = useState<string[]>([]);
  const queuedRef = useRef<string[]>([]);
  const chatIdRef = useRef<string | null>(null);
  useEffect(() => { chatIdRef.current = chatId; }, [chatId]);
  const [error, setError] = useState<string | null>(null);
  const [draftResult, setDraftResult] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [installNote, setInstallNote] = useState<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLLIElement | null>(null);

  const loadAgents = () =>
    fetch(`${apiBase}/api/agents`)
      .then(j)
      .then((data: { agents: Agent[] }) => {
        setAgents(data.agents);
        const first = data.agents.find((a) => a.available);
        if (first) setAgentId(first.id);
      })
      .catch(() => setAgents([]));

  useEffect(() => { void loadAgents(); }, [apiBase]);

  useEffect(() => () => closeRef.current?.(), []);

  // Scroll to bottom on new messages
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const pushQueued = (t: string) => { queuedRef.current = [...queuedRef.current, t]; setQueued(queuedRef.current); };
  const removeQueued = (i: number) => { queuedRef.current = queuedRef.current.filter((_, j) => j !== i); setQueued(queuedRef.current); };
  // Coalesce every queued message into ONE next turn. No-op when empty.
  const fireQueued = () => {
    const q = queuedRef.current;
    if (!q.length) return;
    queuedRef.current = [];
    setQueued([]);
    void sendText(q.join("\n"));
  };

  // Interrupt the in-flight turn (ACP session/cancel) — the session survives; the stream ends with
  // stopReason "cancelled" and any queued messages fire as the next turn.
  const interrupt = async () => {
    const id = chatIdRef.current ?? chatId;
    if (!id) return;
    try { await fetch(`${apiBase}/api/chat/${encodeURIComponent(id)}/cancel`, { method: "POST" }); }
    catch { setError("interrupt failed — the turn will run to completion"); }
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text) return;
    if (sending) { pushQueued(text); setInput(""); return; }   // type-while-busy queues, never drops
    setInput("");
    await sendText(text);
  };

  const sendText = async (text: string) => {
    setError(null);
    setSending(true);

    const userMsg: Message = { role: "user", text, tools: [], streaming: false };
    const assistantMsg: Message = { role: "assistant", text: "", tools: [], streaming: true };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      let activeChatId = chatIdRef.current ?? chatId;
      if (!activeChatId) {
        const res = await fetch(`${apiBase}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId, ...(launch.kind === "project" ? { project: launch.root } : {}) }),
        }).then(j);
        activeChatId = res.chatId as string;
        setChatId(activeChatId);
      }

      closeRef.current?.();
      closeRef.current = openChatStream(activeChatId, text, {
        onDelta: (chunk) => {
          setMessages((prev) => {
            const next = [...prev];
            const idx = next.length - 1; // last message is the streaming assistant msg
            next[idx] = { ...next[idx], text: next[idx].text + chunk };
            return next;
          });
        },
        onTool: (tool) => {
          setMessages((prev) => {
            const next = [...prev];
            const idx = next.length - 1;
            const existing = next[idx].tools.findIndex((t) => t.toolCallId === tool.toolCallId);
            const tools = existing >= 0
              ? next[idx].tools.map((t, i) => (i === existing ? tool : t))
              : [...next[idx].tools, tool];
            next[idx] = { ...next[idx], tools };
            return next;
          });
        },
        onDone: (result) => {
          setMessages((prev) => {
            const next = [...prev];
            const idx = next.length - 1;
            const interrupted = result.stopReason === "cancelled";
            next[idx] = {
              ...next[idx],
              streaming: false,
              text: interrupted ? (next[idx].text ? `${next[idx].text}\n⏹ interrupted` : "⏹ interrupted") : next[idx].text,
            };
            return next;
          });
          setSending(false);
          fireQueued();   // redirect: anything typed mid-turn coalesces into the next turn now
        },
        onFailed: (err) => {
          setMessages((prev) => {
            const next = [...prev];
            const idx = next.length - 1;
            next[idx] = { ...next[idx], streaming: false };
            return next;
          });
          setError(err);
          setSending(false);
        },
      });
    } catch (e) {
      setMessages((prev) => {
        const next = [...prev];
        const idx = next.length - 1;
        next[idx] = { ...next[idx], streaming: false };
        return next;
      });
      setError(e instanceof Error ? e.message : "Send failed");
      setSending(false);
    }
  };

  const draftGem = async () => {
    if (!chatId || drafting) return;
    setDrafting(true);
    setDraftResult(null);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/chat/${encodeURIComponent(chatId)}/draft-gem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }).then(j);
      setDraftResult(res.summary ?? JSON.stringify(res));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Draft failed");
    } finally {
      setDrafting(false);
    }
  };

  const installAgent = async (id: string) => {
    setInstalling(id);
    setConfirmId(null);
    setInstallNote(null);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/agents/${encodeURIComponent(id)}/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consent: true }),
      }).then(j);
      await loadAgents();
      setAgentId(id);
      if (res.needsLogin) setInstallNote(`${id} installed — needs login on first use.`);
    } catch (e) {
      setError(e instanceof Error ? `Install failed: ${e.message}` : "Install failed");
    } finally {
      setInstalling(null);
    }
  };

  return (
    <section className="analyze">
      <p className="analyze-intro">Chat with a coding agent. Start a conversation, then distill it into a Gem.</p>

      {/* Agent picker */}
      <div style={{ marginBottom: 12 }}>
        <label htmlFor="chat-agent-select" style={{ marginRight: 8, fontWeight: 600 }}>Agent</label>
        <select
          id="chat-agent-select"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          disabled={chatId !== null || agents === null}
          className="ledger-search"
          style={{ width: "auto", marginBottom: 0 }}
        >
          {agents === null && <option>Loading…</option>}
          {(agents ?? []).map((a) => (
            <option key={a.id} value={a.id} disabled={!a.available}>
              {a.name}{!a.available ? " (unavailable)" : ""}
            </option>
          ))}
          {agents !== null && agents.length === 0 && <option value="">No agents configured</option>}
        </select>
        <span style={{ marginLeft: 12, marginRight: 8, fontWeight: 600 }}>Start in</span>
        <ScopePicker apiBase={apiBase} scope={launch} onScope={setLaunch} globalLabel="Neutral" disabled={chatId !== null} />
      </div>

      {/* Missing adapters: inline install with a consent confirm */}
      {(agents ?? []).filter((a) => a.installable && !a.available).map((a) => (
        <div key={a.id} style={{ marginBottom: 8, fontSize: 13 }}>
          {confirmId === a.id ? (
            <span className="getgems-consent">
              Install <strong>{a.name}</strong> adapter? Downloads its npm package (~260&nbsp;MB) and runs it locally.
              <button type="button" className="ledger-sort" disabled={installing !== null} onClick={() => installAgent(a.id)}>Install</button>
              <button type="button" className="ledger-sort" onClick={() => setConfirmId(null)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="ledger-sort" disabled={installing !== null} onClick={() => setConfirmId(a.id)}>
              {installing === a.id ? `Installing ${a.name}…` : `Install ${a.name}`}
            </button>
          )}
        </div>
      ))}
      {installNote && <p className="ws-note" style={{ marginBottom: 8 }}>{installNote}</p>}

      {/* Message list */}
      <ul className="analyze-list" style={{ minHeight: 120, maxHeight: 480, overflowY: "auto" }}>
        {messages.length === 0 && (
          <li className="ledger-empty">No messages yet — send one below.</li>
        )}
        {messages.map((msg, i) => (
          <li key={i} className={"analyze-row" + (msg.role === "assistant" ? " is-active" : "")}>
            <div className="analyze-row-head">
              <span className="analyze-name" style={{ fontWeight: msg.role === "user" ? 600 : 400 }}>
                {msg.role === "user" ? "You" : "Agent"}
              </span>
              {msg.streaming && <span className="run-badge run-running">streaming…</span>}
            </div>
            {msg.text && <pre className="run-transcript" style={{ marginTop: 4 }}>{msg.text}</pre>}
            {msg.tools.length > 0 && (
              <ul style={{ listStyle: "none", padding: 0, margin: "4px 0 0" }}>
                {msg.tools.map((t) => (
                  <li key={t.toolCallId}>
                    <span className="ws-chip">{t.title}{t.status ? ` · ${t.status}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        <li ref={bottomRef} style={{ listStyle: "none", padding: 0, margin: 0 }} />
      </ul>

      {error && <p className="ledger-error" role="alert">{error}</p>}

      {/* Queued messages — typed mid-turn, removable until they fire */}
      {queued.length > 0 && (
        <div className="studio-queue" style={{ marginTop: 12 }}>
          {queued.map((q, i) => (
            <span key={`${i}:${q}`} className="studio-queue__chip" title="queued — sends when the agent finishes">
              <span className="studio-queue__text">{q}</span>
              <button aria-label={`remove queued message ${i + 1}`} onClick={() => removeQueued(i)}>✕</button>
            </span>
          ))}
          {!sending && <button type="button" className="ledger-view" onClick={fireQueued}>Send queued</button>}
        </div>
      )}

      {/* Input row — never disabled while a turn runs: typing queues */}
      <div className="run-status" style={{ marginTop: 12, gap: 8 }}>
        <input
          className="ledger-search"
          type="text"
          placeholder="Type a message…"
          aria-label="chat message"
          value={input}
          disabled={agents === null || (agents?.length === 0)}
          style={{ flex: 1, marginBottom: 0 }}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
        />
        {sending && (
          <button type="button" className="ledger-sort" title="interrupt this turn — the session survives" onClick={() => void interrupt()}>
            Interrupt
          </button>
        )}
        <button
          type="button"
          className="ledger-view"
          disabled={!input.trim() || agents === null || (agents?.length === 0)}
          onClick={() => void sendMessage()}
        >
          {sending ? "Queue" : "Send →"}
        </button>
      </div>

      {/* Draft a Gem */}
      {chatId && (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            className="ledger-build"
            disabled={drafting || sending}
            onClick={() => void draftGem()}
          >
            {drafting ? "Drafting…" : "Draft a Gem ◆"}
          </button>
          {draftResult && (
            <div className="run-out analyze-status" style={{ marginTop: 8 }}>
              <div className="run-status">
                <span className="run-badge run-done">draft ready</span>
              </div>
              <pre className="run-transcript">{draftResult}</pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export const chatPage = defineConsolePage({
  id: "chat",
  title: "Chat",
  icon: "💬",
  order: 50,
  phase: "observe", category: "sessions",
  group: "build", hiddenUntilUnlock: true,
  route: "#/chat",
  component: Chat,
});

import { useEffect, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { openChatStream, type ChatToolChip } from "./chatStream.js";

interface Agent {
  id: string;
  name: string;
  description?: string;
  available: boolean;
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftResult, setDraftResult] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const closeRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/api/agents`)
      .then(j)
      .then((data: { agents: Agent[] }) => {
        setAgents(data.agents);
        const first = data.agents.find((a) => a.available);
        if (first) setAgentId(first.id);
      })
      .catch(() => setAgents([]));
  }, [apiBase]);

  useEffect(() => () => closeRef.current?.(), []);

  // Scroll to bottom on new messages
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setError(null);
    setSending(true);

    const userMsg: Message = { role: "user", text, tools: [], streaming: false };
    const assistantMsg: Message = { role: "assistant", text: "", tools: [], streaming: true };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    const assistantIdx = messages.length + 1; // index after adding both

    try {
      let activeChatId = chatId;
      if (!activeChatId) {
        const res = await fetch(`${apiBase}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId }),
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
        onDone: () => {
          setMessages((prev) => {
            const next = [...prev];
            const idx = next.length - 1;
            next[idx] = { ...next[idx], streaming: false };
            return next;
          });
          setSending(false);
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

    void assistantIdx; // suppress lint — idx computed via closure
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
      </div>

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
        <div ref={bottomRef} />
      </ul>

      {error && <p className="ledger-error" role="alert">{error}</p>}

      {/* Input row */}
      <div className="run-status" style={{ marginTop: 12, gap: 8 }}>
        <input
          className="ledger-search"
          type="text"
          placeholder="Type a message…"
          aria-label="chat message"
          value={input}
          disabled={sending || agents === null || (agents?.length === 0)}
          style={{ flex: 1, marginBottom: 0 }}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
        />
        <button
          type="button"
          className="ledger-view"
          disabled={sending || !input.trim() || agents === null || (agents?.length === 0)}
          onClick={() => void sendMessage()}
        >
          {sending ? "Sending…" : "Send →"}
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
  order: 15,
  group: "build",
  route: "#/chat",
  component: Chat,
});

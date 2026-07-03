import { useEffect, useMemo, useState } from "react";
import { openEventStream, type FeedEvent } from "./eventStream.js";

// One render row. A tool_call and its (later) tool_result collapse into a single
// `tool` item — the live "running → done" card. Messages stay one item each.
export type FeedItem =
  | { kind: "message"; key: string; role: "user" | "assistant"; text: string }
  | { kind: "tool"; key: string; toolId: string | null; name: string; input: string; output?: string; error?: boolean; done: boolean };

// Fold the append-only event stream into display items, pairing each tool_result
// back onto its tool_call by toolId. Messages pass through 1:1; a tool_call becomes
// a pending `tool` item that its later tool_result completes in place (mutating the
// same object we already pushed). A result with no matching call renders standalone.
// Pure over `events`, so React re-derives it whenever the stream grows.
export function toItems(events: FeedEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  const byTool = new Map<string, Extract<FeedItem, { kind: "tool" }>>();
  for (const e of events) {
    const s = e.span;
    if (s.kind === "message") {
      items.push({ kind: "message", key: `m${e.index}`, role: s.role, text: s.text });
    } else if (s.kind === "tool_call") {
      const item: Extract<FeedItem, { kind: "tool" }> =
        { kind: "tool", key: `t${e.index}`, toolId: s.toolId, name: s.name, input: s.input, done: false };
      items.push(item);
      if (s.toolId) byTool.set(s.toolId, item);
    } else {
      const call = s.toolId ? byTool.get(s.toolId) : undefined;
      if (call) { call.output = s.output; call.error = s.error; call.done = true; }
      else items.push({ kind: "tool", key: `r${e.index}`, toolId: s.toolId, name: "result", input: "", output: s.output, error: s.error, done: true });
    }
  }
  return items;
}

// Pull the one arg that best summarises a tool call, so the card header reads like
// what the agent is actually doing (the command, the file, the query) rather than raw JSON.
function toolHeadline(input: string): string {
  let o: unknown;
  try { o = JSON.parse(input); } catch { return ""; }
  if (!o || typeof o !== "object") return "";
  const r = o as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "url", "query"]) {
    if (typeof r[k] === "string") return r[k] as string;
  }
  return "";
}

const TOOL_ICON: Record<string, string> = {
  Bash: "❯", Write: "✎", Edit: "✎", MultiEdit: "✎", Read: "📖",
  TodoWrite: "☑", Grep: "🔎", Glob: "🔎", WebFetch: "🌐", Task: "🤖",
};

function MessageCard({ role, text }: { role: "user" | "assistant"; text: string }) {
  return (
    <div className={"feed-card feed-msg feed-msg-" + role}>
      <span className="feed-msg-role">{role}</span>
      <div className="feed-msg-text">{text}</div>
    </div>
  );
}

function ToolCard({ item }: { item: Extract<FeedItem, { kind: "tool" }> }) {
  const icon = TOOL_ICON[item.name] ?? "🔧";
  const headline = toolHeadline(item.input);
  return (
    <div className={"feed-card feed-tool" + (item.error ? " is-error" : "")}>
      <div className="feed-tool-head">
        <span className="feed-tool-icon" aria-hidden>{icon}</span>
        <span className="feed-tool-name">{item.name}</span>
        {headline && <code className="feed-tool-arg">{headline}</code>}
        <span className={"run-badge " + (item.done ? "run-done" : "run-running")}>
          {item.done ? (item.error ? "error" : "done") : "running"}
        </span>
      </div>
      {item.output != null && <pre className="feed-tool-out">{item.output}</pre>}
    </div>
  );
}

// The live activity feed for one session: hand-authored cards, streaming data.
export function SessionFeed({ apiBase, file }: { apiBase: string; file: string }) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [phase, setPhase] = useState<string>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEvents([]); setPhase("connecting"); setError(null);
    return openEventStream(apiBase, file, (m) => {
      if (m.type === "phase") setPhase(m.phase);
      else if (m.type === "failed") { setError(m.message); setPhase(""); }
      else setEvents((prev) => [...prev, m.event]); // append-only, ordered by index
    });
  }, [apiBase, file]);

  const items = useMemo(() => toItems(events), [events]);

  return (
    <div>
      <div className="run-status" style={{ gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        {phase && !error && <span className="run-badge run-running">{phase}</span>}
      </div>
      {error && <p className="ledger-error" role="alert">{error}</p>}
      {items.length === 0 && !error && <p className="ledger-empty">Waiting for session activity…</p>}
      <div className="feed">
        {items.map((it) =>
          it.kind === "message"
            ? <MessageCard key={it.key} role={it.role} text={it.text} />
            : <ToolCard key={it.key} item={it} />,
        )}
      </div>
    </div>
  );
}

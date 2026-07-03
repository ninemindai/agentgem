import { useEffect, useRef, useState, useCallback } from "react";
import { defineConsolePage } from "../../registry.js";
import { timeAgo } from "../../util/timeAgo.js";
import { setPendingAnalyze } from "../../pendingAnalyze.js";
import { getStatus, getJourney, post, type DreamStatus, type JourneyEvent } from "./api.js";

const KINDS = ["all", "skill", "lesson", "opportunity", "pass", "verified"] as const;
const PHASES = ["LIGHT", "DEEP", "REM"] as const;

/** Journey: the unified learning timeline — everything the background job and
 *  intent-driven /learn distilled (queue items across all statuses), dream passes,
 *  and gem verification results, newest first. Nothing lands without accept. */
export function Dreaming({ apiBase }: { apiBase: string }) {
  const [filter, setFilter] = useState<(typeof KINDS)[number]>("all");
  const [status, setStatus] = useState<DreamStatus | null>(null);
  const [events, setEvents] = useState<JourneyEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const refresh = useCallback(() => {
    getStatus(apiBase).then(setStatus).catch(() => setStatus(null));
    getJourney(apiBase, filter === "all" ? undefined : filter)
      .then((r) => { setEvents(r.events); setTruncated(r.truncated); })
      .catch(() => setEvents([]));
  }, [apiBase, filter]);
  useEffect(() => { refresh(); }, [refresh]);

  const act = (path: string, key: string) =>
    post(apiBase, path, { key }).then(() => { setError(null); refresh(); }).catch(() => setError("Action failed — try again."));

  // Opportunity accept routes into Curate's "suggest from a project" flow (unchanged bridge).
  const openOpportunity = (e: JourneyEvent) =>
    post(apiBase, "queue/accept", { key: e.key }).then(() => {
      if (e.root) setPendingAnalyze(e.root);
      window.location.hash = "#/curate";
    }).catch(() => setError("Could not open this opportunity."));

  // "Dream now" is fire-and-forget server-side (POST /dream/run returns {started} and the
  // pass runs in the background), so give immediate feedback (button → "Dreaming…") and
  // poll `lastPassAtMs` until a new pass lands — instead of a blind refresh that showed nothing.
  const runDream = useCallback(async () => {
    setError(null);
    setNote(null);
    setRunning(true);
    const before = status?.lastPassAtMs ?? null;
    try {
      await post(apiBase, "run");
      let landed = false;
      for (let i = 0; i < 12 && !landed && aliveRef.current; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        if (!aliveRef.current) return;
        const s = await getStatus(apiBase).catch(() => null);
        if (s && aliveRef.current) {
          setStatus(s);
          if (s.lastPassAtMs != null && s.lastPassAtMs !== before) landed = true;
        }
      }
      if (!aliveRef.current) return;
      getJourney(apiBase, filter === "all" ? undefined : filter)
        .then((r) => { if (aliveRef.current) { setEvents(r.events); setTruncated(r.truncated); } })
        .catch(() => {});
      setNote(landed ? "Dream pass complete." : "Dream pass is running in the background — new drafts appear here as they're ready.");
    } catch {
      if (aliveRef.current) setError("Dream run failed.");
    } finally {
      if (aliveRef.current) setRunning(false);
    }
  }, [apiBase, status, filter]);

  const actionable = (e: JourneyEvent) => e.key && e.status === "queued";

  return (
    <div className="dreaming">
      <header>
        <h1>Journey</h1>
        <p>Everything your sessions taught AgentGem, in order. Nothing lands without your accept.</p>
        <span className="dream-flag" data-on={!!status?.enabled}>{status?.enabled ? "DREAMING ON" : "DREAMING OFF"}</span>
        <button className="dream-btn" onClick={() => post(apiBase, "enable", { enabled: !status?.enabled }).then(() => { setError(null); refresh(); }).catch(() => setError("Could not change Dreaming."))}>
          {status?.enabled ? "Turn off" : "Turn on"}
        </button>
      </header>

      {status && (
        <section className="dream-scene">
          <div className="phases">
            {PHASES.map((p) => <span key={p} data-lit={status.phasesLit.includes(p)}>{p}</span>)}
          </div>
          <p className="dream-counts">{status.promoted} promoted · {status.queued} queued</p>
          <button className="dream-btn" disabled={running} onClick={runDream}>{running ? "Dreaming…" : "Dream now"}</button>
        </section>
      )}

      <nav className="dream-tabs">
        {KINDS.map((k) => (
          <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{k}</button>
        ))}
      </nav>

      {error && <p className="ledger-error" role="alert">{error}</p>}
      {note && <p className="dream-counts" role="status">{note}</p>}

      <ul className="dream-queue journey-timeline">
        {events.map((e) => (
          <li key={`${e.kind}:${e.key ?? e.title}:${e.ts}`}>
            <span className="dream-item-when">{timeAgo(e.ts)}</span>
            <span className="dream-item-kind">{e.kind}</span>
            {e.phase === "LEARN" && <span className="dream-item-phase">LEARN</span>}
            <span className="dream-item-name">{e.title}</span>
            {e.detail && <span className="dream-item-summary">{e.detail}</span>}
            {e.kind === "verified" && <span className="dream-item-verdict" data-passed={e.passed}>{e.passed ? `✓ ${e.agent}` : `✗ ${e.agent}`}</span>}
            {e.status && e.status !== "queued" && <span className="dream-item-status">{e.status}</span>}
            {actionable(e) && (e.kind === "opportunity"
              ? <button className="dream-act is-accept" onClick={() => openOpportunity(e)}>Publish →</button>
              : <button className="dream-act is-accept" onClick={() => act("queue/accept", e.key!)}>Accept</button>)}
            {actionable(e) && <button className="dream-act" onClick={() => act("queue/dismiss", e.key!)}>Dismiss</button>}
          </li>
        ))}
        {events.length === 0 && <li className="is-empty">Nothing on the timeline yet.</li>}
      </ul>
      {truncated && <p className="dream-truncated">Showing the newest 100 events.</p>}
    </div>
  );
}

export const dreamingPage = defineConsolePage({
  id: "dreaming", title: "Journey", icon: "🌙", order: 9, group: "observe",
  route: "#/dreaming", component: Dreaming,
});

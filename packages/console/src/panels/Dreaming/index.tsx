import { useEffect, useState, useCallback } from "react";
import { defineConsolePage } from "../../registry.js";
import { timeAgo } from "../../util/timeAgo.js";
import { setPendingAnalyze } from "../../pendingAnalyze.js";
import { getStatus, getQueue, getDiary, post, type DreamStatus, type DreamItem, type DreamDiaryEntry } from "./api.js";

const PHASES = ["LIGHT", "DEEP", "REM"] as const;

/** Dreaming: surfaces what the background warm/dream job already learned
 *  (skills + lessons distilled from cached usage/analyze/insights passes) and
 *  lets the operator accept or dismiss each draft. Nothing is written to disk
 *  until accepted here. */
export function Dreaming({ apiBase }: { apiBase: string }) {
  const [tab, setTab] = useState<"review" | "diary">("review");
  const [status, setStatus] = useState<DreamStatus | null>(null);
  const [items, setItems] = useState<DreamItem[]>([]);
  const [diary, setDiary] = useState<DreamDiaryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getStatus(apiBase).then(setStatus).catch(() => setStatus(null));
    getQueue(apiBase).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [apiBase]);
  useEffect(() => { refresh(); }, [refresh]);
  // Diary is historical — fetch it only when its tab is opened, not on every action.
  useEffect(() => {
    if (tab === "diary") getDiary(apiBase).then((r) => setDiary(r.entries ?? [])).catch(() => setDiary([]));
  }, [tab, apiBase]);

  const act = (path: string, key: string) =>
    post(apiBase, path, { key }).then(() => { setError(null); refresh(); }).catch(() => setError("Action failed — try again."));

  // An opportunity is a succeeded session worth publishing: acknowledge it (mark
  // accepted) and route into Curate's "suggest from a project" flow, pre-loaded with
  // the session's project — the same bridge the Insights panel uses.
  const openOpportunity = (it: DreamItem) =>
    post(apiBase, "queue/accept", { key: it.key }).then(() => {
      setPendingAnalyze(it.root);
      window.location.hash = "#/curate";
    }).catch(() => setError("Could not open this opportunity."));

  return (
    <div className="dreaming">
      <header>
        <h1>Dreaming</h1>
        <p>Consolidates what the background job already learned. Nothing lands without your accept.</p>
        <span className="dream-flag" data-on={!!status?.enabled}>{status?.enabled ? "DREAMING ON" : "DREAMING OFF"}</span>
        <button className="dream-btn" onClick={() => post(apiBase, "enable", { enabled: !status?.enabled }).then(() => { setError(null); refresh(); }).catch(() => setError("Could not change Dreaming."))}>
          {status?.enabled ? "Turn off" : "Turn on"}
        </button>
      </header>

      <nav className="dream-tabs">
        {(["review", "diary"] as const).map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>

      {error && <p className="ledger-error" role="alert">{error}</p>}

      {tab === "review" && (
        <>
          {status && (
            <section className="dream-scene">
              <div className="phases">
                {PHASES.map((p) => <span key={p} data-lit={status.phasesLit.includes(p)}>{p}</span>)}
              </div>
              <p className="dream-counts">{status.promoted} promoted · {status.queued} queued</p>
              <button className="dream-btn" onClick={() => post(apiBase, "run").then(() => { setError(null); setTimeout(refresh, 1500); }).catch(() => setError("Dream run failed."))}>Dream now</button>
            </section>
          )}
          <ul className="dream-queue">
            {items.map((it) => (
              <li key={it.key}>
                <span className="dream-item-name">{it.name}</span>
                <span className="dream-item-kind">{it.kind}</span>
                <span className="dream-item-summary">{it.summary}</span>
                {it.kind === "opportunity"
                  ? <button className="dream-act is-accept" onClick={() => openOpportunity(it)}>Publish →</button>
                  : <button className="dream-act is-accept" onClick={() => act("queue/accept", it.key)}>Accept</button>}
                <button className="dream-act" onClick={() => act("queue/dismiss", it.key)}>Dismiss</button>
              </li>
            ))}
            {items.length === 0 && <li className="is-empty">Nothing queued yet.</li>}
          </ul>
        </>
      )}

      {tab === "diary" && (
        diary.length === 0
          ? <p className="dream-diary">No dream passes yet.</p>
          : <ul className="dream-diary-list">
              {diary.map((d) => (
                <li key={`${d.passId}:${d.atMs}`}>
                  <span className="dream-diary-when">{timeAgo(d.atMs)}</span>
                  <span className="dream-diary-phases">{d.phasesLit.join(" · ") || "—"}</span>
                  <span className="dream-diary-count">+{d.enqueued.skills} skills · +{d.enqueued.lessons} lessons · +{d.enqueued.opportunities ?? 0} opportunities</span>
                  {d.degraded && <span className="dream-diary-degraded">degraded</span>}
                </li>
              ))}
            </ul>
      )}
    </div>
  );
}

export const dreamingPage = defineConsolePage({
  id: "dreaming", title: "Dreaming", icon: "🌙", order: 9, group: "observe",
  route: "#/dreaming", component: Dreaming,
});

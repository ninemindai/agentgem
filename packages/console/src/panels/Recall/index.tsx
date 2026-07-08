// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { useRecallSearch } from "./useRecall.js";
import { MomentCard, selectionKey } from "./MomentCard.js";
import { ExitDrawer } from "./ExitDrawer.js";

const SINCE_OPTIONS: { label: string; days: number | undefined }[] = [
  { label: "Any time", days: undefined },
  { label: "Last 24h", days: 1 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

export interface SessionRef { sessionId: string; agent: string }
type Exit = { mode: "chat" | "extract"; sessions: SessionRef[] };

/** Recall: instant BM25 search across every past session's transcript, then two
 *  exits over the selected moments — chat with them or extract a batch report.
 *  The exits themselves (Task 3's <ExitDrawer>) are not wired here; this panel
 *  just picks a mode + a session set and renders a slot for that drawer. */
export function Recall({ apiBase }: { apiBase: string }) {
  const { query, setQuery, filters, setFilters, moments, pending, error, status } = useRecallSearch(apiBase);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exit, setExit] = useState<Exit | null>(null);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Reconcile stale selection: when the moment list changes (new query), drop any
  // selected keys no longer present so the "N selected" count, the exit buttons'
  // disabled state, and selectedSessions all agree on the same set.
  useEffect(() => {
    const validKeys = new Set(moments.map(selectionKey));
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => validKeys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [moments]);

  const selectedSessions = useMemo<SessionRef[]>(
    () => moments.filter((m) => selected.has(selectionKey(m))).map((m) => ({ sessionId: m.sessionId, agent: m.agent })),
    [moments, selected],
  );

  const searching = query.trim().length > 0;

  return (
    <div className="rc">
      <h1 className="rc-head">Recall</h1>
      <p className="rc-sub">
        Search every past session by what happened inside it, then <b>chat with</b> or{" "}
        <b>extract across</b> the ones that matter. Search is instant and local; the deeper
        read runs only when you ask.
      </p>

      <div className="rc-searchbar">
        <div className="rc-search-wrap">
          <span className="rc-search-ico" aria-hidden="true">🔍</span>
          <input
            className="rc-search"
            aria-label="Search transcripts"
            placeholder="Search across every session…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="rc-filters">
          <select
            className={"rc-filter" + (filters.project ? " is-set" : "")}
            aria-label="project"
            value={filters.project ?? ""}
            onChange={(e) => setFilters({ ...filters, project: e.target.value || undefined })}
          >
            <option value="">All projects</option>
            {filters.project && <option value={filters.project}>{filters.project}</option>}
          </select>
          <select
            className={"rc-filter" + (filters.agent ? " is-set" : "")}
            aria-label="agent"
            value={filters.agent ?? ""}
            onChange={(e) => setFilters({ ...filters, agent: e.target.value || undefined })}
          >
            <option value="">All agents</option>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
          <select
            className={"rc-filter" + (filters.sinceDays ? " is-set" : "")}
            aria-label="since"
            value={filters.sinceDays ?? ""}
            onChange={(e) => {
              const days = e.target.value ? Number(e.target.value) : undefined;
              setFilters({ ...filters, sinceDays: days });
            }}
          >
            {SINCE_OPTIONS.map((o) => <option key={o.label} value={o.days ?? ""}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {!searching && (
        <p className="rc-emptywork">Type to search across your session history.</p>
      )}

      {searching && error && <p className="rc-emptywork">Couldn't search: {error}</p>}

      {searching && !error && (
        <>
          <div className="rc-resultmeta">
            Moments across {status?.total ?? "…"} sessions · {moments.length} matched
            {pending && " · searching…"}
          </div>
          {status && !status.ready && (
            <p className="rc-sub">
              Indexing your sessions… ({status.indexed} of {status.total})
            </p>
          )}
          {status?.ready && !pending && moments.length === 0 && (
            <p className="rc-emptywork">No moments match.</p>
          )}
          <ul className="rc-moments">
            {moments.map((m) => (
              <MomentCard key={selectionKey(m)} hit={m} picked={selected.has(selectionKey(m))} onToggle={toggle} />
            ))}
          </ul>
        </>
      )}

      <div className="rc-actions">
        <span className="rc-selcount"><b>{selected.size}</b> selected</span>
        <span className="rc-actions-spacer" />
        <button
          type="button"
          className="rc-btn rc-btn--ghost"
          disabled={selected.size === 0 || exit !== null}
          onClick={() => setExit({ mode: "chat", sessions: selectedSessions })}
        >
          💬 Chat with these
        </button>
        <button
          type="button"
          className="rc-btn rc-btn--primary"
          disabled={selected.size === 0 || exit !== null}
          onClick={() => setExit({ mode: "extract", sessions: selectedSessions })}
        >
          ⇩ Extract across these
        </button>
      </div>

      {exit && (
        // Keyed by mode + the exact session selection so switching exit mode (or
        // selection) forces a real remount, running the outgoing drawer's
        // unmount-teardown instead of racing its in-flight request/stream.
        <ExitDrawer
          key={exit.mode + ":" + exit.sessions.map((s) => s.agent + ":" + s.sessionId).join(",")}
          mode={exit.mode}
          sessions={exit.sessions}
          apiBase={apiBase}
          onClose={() => setExit(null)}
        />
      )}
    </div>
  );
}

export const recallPage = defineConsolePage({
  id: "recall",
  title: "Recall",
  icon: "✦",
  order: 6,
  phase: "observe",
  category: "sessions",
  route: "#/recall",
  component: Recall,
});

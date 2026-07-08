// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { recallSearchRoute, recallStatusRoute, makeClient, type MomentHit } from "../../api/routes.js";

const DEBOUNCE_MS = 250;

export interface RecallFilters {
  project?: string;
  agent?: string;
  /** Relative day-count preset (matches the <select> option values); the epoch
   *  cutoff sent to the server is derived from this at request-build time so the
   *  controlled <select> always has a value that matches one of its options. */
  sinceDays?: number;
}

export interface RecallStatus {
  ready: boolean;
  indexed: number;
  total: number;
}

/** Recall's search state: debounced BM25 search over the local moment index, plus a
 *  one-shot status fetch for the "indexed N/M" hint. Mirrors useObserveData's
 *  alive-guard/cleanup shape. An empty/whitespace query is a local no-op (no request,
 *  moments cleared) — the panel shows a placeholder instead of an all-sessions dump. */
export function useRecallSearch(apiBase: string) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<RecallFilters>({});
  const [moments, setMoments] = useState<MomentHit[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RecallStatus | null>(null);

  useEffect(() => {
    let alive = true;
    recallStatusRoute.call(makeClient(apiBase))
      .then((s) => { if (alive) setStatus(s); })
      .catch(() => { /* status is a soft hint (indexing progress) — ignore failures */ });
    return () => { alive = false; };
  }, [apiBase]);

  useEffect(() => {
    let alive = true;
    const q = query.trim();
    if (!q) {
      setMoments([]);
      setPending(false);
      setError(null);
      return;
    }
    setPending(true);
    setError(null);
    const timer = setTimeout(() => {
      const since = filters.sinceDays ? Date.now() - filters.sinceDays * 86_400_000 : undefined;
      recallSearchRoute.call(makeClient(apiBase), { query: { q, project: filters.project, agent: filters.agent, since } })
        .then((p) => { if (alive) setMoments(p.moments); })
        .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
        .finally(() => { if (alive) setPending(false); });
    }, DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filters is a small plain object; spread its fields to avoid re-running on every new-object identity
  }, [apiBase, query, filters.project, filters.agent, filters.sinceDays]);

  return { query, setQuery, filters, setFilters, moments, pending, error, status };
}

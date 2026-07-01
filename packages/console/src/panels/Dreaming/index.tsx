import { useEffect, useState, useCallback } from "react";
import { defineConsolePage } from "../../registry.js";
import { getStatus, getQueue, post, type DreamStatus, type DreamItem } from "./api.js";

const PHASES = ["LIGHT", "DEEP", "REM"] as const;

/** Dreaming: surfaces what the background warm/dream job already learned
 *  (skills + lessons distilled from cached usage/analyze/insights passes) and
 *  lets the operator accept or dismiss each draft. Nothing is written to disk
 *  until accepted here. */
export function Dreaming({ apiBase }: { apiBase: string }) {
  const [tab, setTab] = useState<"scene" | "queue" | "diary">("scene");
  const [status, setStatus] = useState<DreamStatus | null>(null);
  const [items, setItems] = useState<DreamItem[]>([]);

  const refresh = useCallback(() => {
    getStatus(apiBase).then(setStatus).catch(() => setStatus(null));
    getQueue(apiBase).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [apiBase]);
  useEffect(() => { refresh(); }, [refresh]);

  const act = async (path: string, key: string) => { await post(apiBase, path, { key }); refresh(); };

  return (
    <div className="dreaming">
      <header>
        <h1>Dreaming</h1>
        <p>Consolidates what the background job already learned. Nothing lands without your accept.</p>
        <span>{status?.enabled ? "DREAMING ON" : "DREAMING OFF"}</span>
        <button onClick={() => post(apiBase, "enable", { enabled: !status?.enabled }).then(refresh)}>
          {status?.enabled ? "Turn off" : "Turn on"}
        </button>
      </header>

      <nav>
        {(["scene", "queue", "diary"] as const).map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>

      {status && (
        <section className="dreaming-scene">
          <div className="phases">
            {PHASES.map((p) => <span key={p} data-lit={status.phasesLit.includes(p)}>{p}</span>)}
          </div>
          <p>{status.promoted} promoted · {status.queued} queued</p>
          <button onClick={() => post(apiBase, "run").then(() => setTimeout(refresh, 1500))}>Dream now</button>
        </section>
      )}

      <ul className="dreaming-queue">
        {items.map((it) => (
          <li key={it.key}>
            <strong>{it.name}</strong> <em>{it.kind}</em> — {it.summary}
            <button onClick={() => act("queue/accept", it.key)}>Accept</button>
            <button onClick={() => act("queue/dismiss", it.key)}>Dismiss</button>
          </li>
        ))}
        {items.length === 0 && <li>Nothing queued yet.</li>}
      </ul>

      {tab === "diary" && <p>Diary view — pass history (wire to /api/dream/diary in a follow-up).</p>}
    </div>
  );
}

export const dreamingPage = defineConsolePage({
  id: "dreaming", title: "Dreaming", icon: "🌙", order: 9, group: "observe",
  route: "#/dreaming", component: Dreaming,
});

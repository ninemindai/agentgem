// packages/console/src/panels/Observe/TranscriptViewer.tsx
//
// Per-session drill-down (Inspect Phase 2): a hierarchical turn -> span tree that
// replays one session in time order, with verbatim (scrubbed) message text, tool
// I/O, and per-turn token/cost chips. Reads the lazy, scrubbed transcript route;
// reuses the obs-* token family so it sits inside the existing Inspect styling.
import { useEffect, useState } from "react";
import {
  inspectSessionRoute, inspectDistillRoute, makeClient,
  type TranscriptView, type TranscriptTurn, type DistilledSkill, type DistilledLesson,
} from "../../api/routes.js";
import { fmtTokens, fmtDuration, fmtTime } from "./data.js";
import { Loading } from "../../shell/Loading.js";
import { DraftCard, LessonCard } from "./gemCards.js";
import { ProcessQualityReport } from "./ProcessQualityReport.js";
import { StructureView } from "./StructureView.js";

export function TranscriptViewer({ apiBase, agent, sessionId, onBack, turn }: {
  apiBase: string; agent: "claude" | "codex"; sessionId: string; onBack: () => void; turn?: number;
}) {
  const [view, setView] = useState<TranscriptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    setView(null); setError(null);
    inspectSessionRoute.call(makeClient(apiBase), { query: { id: sessionId, agent } })
      .then((v) => { if (alive) setView(v); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [apiBase, agent, sessionId]);

  // Recall's "Open turn ↗" deep link: expand the targeted turn and scroll it into
  // view once the transcript has loaded. Out-of-range `turn` is a silent no-op.
  const targetId = turn !== undefined ? view?.turns[turn]?.id : undefined;
  useEffect(() => {
    if (targetId === undefined) return;
    setCollapsed((prev) => { if (!prev.has(targetId)) return prev; const next = new Set(prev); next.delete(targetId); return next; });
    document.getElementById("turn-" + targetId)?.scrollIntoView({ block: "center" });
  }, [targetId]);

  const toggle = (id: string) =>
    setCollapsed((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const allCollapsed = view ? collapsed.size >= view.turns.length : false;
  const setAll = () => {
    if (!view) return;
    setCollapsed(allCollapsed ? new Set() : new Set(view.turns.map((t) => t.id)));
  };

  return (
    <div className="obs tv">
      <div className="tv-head">
        <button type="button" className="tv-back" onClick={onBack}>← Overview</button>
        {view && (
          <>
            <h2 className="obs-title tv-title">{view.meta.project ?? "session"}</h2>
            <span className="obs-chip">{view.agent}</span>
            <span className="obs-muted tv-meta">
              {view.meta.model ?? "—"} · {fmtDuration(view.meta.endMs - view.meta.startMs)} · {view.meta.msgs} msgs ·{" "}
              {fmtTokens(view.meta.tokensIn + view.meta.tokensOut)} tokens{" "}
              (in {fmtTokens(view.meta.tokensIn)} · out {fmtTokens(view.meta.tokensOut)} · cache {fmtTokens(view.meta.tokensCache)}) ·{" "}
              {fmtTime(view.meta.startMs)} → {fmtTime(view.meta.endMs)} · branch {view.meta.gitBranch ?? "—"}
            </span>
            {view.turns.length > 0 && (
              <button type="button" className="obs-sort-btn tv-collapse" onClick={setAll}>
                {allCollapsed ? "Expand all" : "Collapse all"}
              </button>
            )}
            {/* The "Compare with…" picker is intentionally not surfaced: arbitrary
                session-vs-session diff is mostly noise. The diff engine (diff.ts,
                TranscriptDiff) and the #/inspect/<a>/<id>?vs=<a>:<id> route remain,
                to be re-surfaced as "diff against a reference run" when that exists. */}
          </>
        )}
      </div>

      {view && <ProcessQualityReport apiBase={apiBase} agent={agent} sessionId={view.sessionId} />}
      {view && <DistillSection apiBase={apiBase} agent={agent} sessionId={view.sessionId} turns={view.turns} />}

      {error ? (
        <p className="obs-error">Couldn't load session: {error}</p>
      ) : !view ? (
        <Loading />
      ) : view.turns.length === 0 ? (
        <p className="obs-empty">This session has no readable turns.</p>
      ) : (
        <StructureView key={targetId ?? "default"} view={view} collapsed={collapsed} onToggle={toggle} forceTx={targetId !== undefined} apiBase={apiBase} agent={agent} />
      )}
    </div>
  );
}

// "Distill this session" CTA (phase 3): runs the existing distill pipeline over
// this one session and lists the resulting draft skill(s). Claude-only — the
// workflow scan reads Claude transcripts. Annotation/scoring is deliberately out
// of scope (proposal non-goals): this is just tagging-via-distill, not an eval rig.
function DistillSection({ apiBase, agent, sessionId, turns }: { apiBase: string; agent: "claude" | "codex"; sessionId: string; turns: TranscriptTurn[] }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [drafts, setDrafts] = useState<DistilledSkill[]>([]);
  const [lessons, setLessons] = useState<DistilledLesson[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Distillation is Claude-only (the pipeline drives an ACP Claude agent). Don't
  // offer the CTA for a session too thin to yield anything: a skill needs a tool
  // procedure, a lesson needs real substance. Below this floor — a couple of
  // message exchanges, no tool use — the run only ever returns "nothing found",
  // so a prominent button there is noise.
  const substantive = turns.some((t) => t.spans.some((s) => s.kind === "tool_call")) || turns.length >= 6;
  if (agent !== "claude" || !substantive) return null;

  const run = () => {
    setState("running"); setErr(null);
    inspectDistillRoute.call(makeClient(apiBase), { body: { id: sessionId, agent } })
      .then((r) => { setDrafts(r.distilled); setLessons(r.lessons); setDegraded(r.degraded); setState("done"); })
      .catch((e) => { setErr(String(e?.message ?? e)); setState("error"); });
  };

  return (
    <div className="tv-distill">
      <button type="button" className="tv-distill-btn" onClick={run} disabled={state === "running"}>
        {state === "running" ? "Distilling…" : "✦ Distill this session"}
      </button>
      {state === "error" && <span className="obs-error tv-distill-note">{err}</span>}
      {state === "done" && degraded && (
        <span className="obs-muted tv-distill-note">Heuristic draft — no local agent ran; start a Claude ACP agent for richer distillation.</span>
      )}
      {state === "done" && drafts.length === 0 && lessons.length === 0 && (
        <span className="obs-muted tv-distill-note">No distillable procedure or lesson found in this session.</span>
      )}
      {drafts.map((d) => <DraftCard key={d.name} apiBase={apiBase} draft={d} />)}
      {lessons.map((l) => <LessonCard key={l.name} apiBase={apiBase} lesson={l} />)}
    </div>
  );
}

// DraftCard / LessonCard moved to gemCards.tsx (re-exported for compatibility).
export { DraftCard, LessonCard } from "./gemCards.js";

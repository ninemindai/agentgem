// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/SessionDashboard.tsx
//
// Dashboard lens (Inspect → Session), two artifacts behind one toggle:
// - Summary: the same agent-generated compact dashboard the Watch panel used to
//   render live, produced once for a completed session.
// - Report: the long-form editorial readout (renderReport / agentgem-report
//   contract, same engine as the rubric reports) built from deterministic
//   session facts — session basics, blast summary, hygiene readout.
// Both cache server-side by (sessionId, kind, transcript mtime). One-shot — no
// SSE double-buffer; a single sealed srcdoc iframe (sandboxDoc CSP, null
// origin). Works for both agents — the server resolves by id.
import { useEffect, useState } from "react";
import { inspectDistillRoute, makeClient, type DistilledSkill, type DistilledLesson } from "../../api/routes.js";
import { openSessionDashboardStream, type SessionDashboardEvent, type SessionDashboardKind, type RecommendedAction } from "./dashboardStream.js";
import { sandboxDoc } from "../Watch/sandboxDoc.js";
import { fmtTime } from "./data.js";
import { DraftCard, LessonCard } from "./gemCards.js";

type Phase =
  | { kind: "connecting" }
  | { kind: "generating"; chars: number }
  | { kind: "done"; html: string; cached: boolean; updatedAt: number; actions?: RecommendedAction[] }
  | { kind: "failed"; message: string };

export function SessionDashboard({ apiBase, agent, sessionId }: { apiBase: string; agent: "claude" | "codex"; sessionId: string }) {
  const [mode, setMode] = useState<SessionDashboardKind>("summary");
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
  const [run, setRun] = useState(0);            // bump to re-open the stream
  const [fresh, setFresh] = useState(false);    // regenerate on the next open

  useEffect(() => {
    setPhase({ kind: "connecting" });
    let chars = 0;
    const close = openSessionDashboardStream(makeClient(apiBase), { id: sessionId, agent, fresh, kind: mode }, (e: SessionDashboardEvent) => {
      if (e.type === "start" && !e.cached) setPhase({ kind: "generating", chars: 0 });
      else if (e.type === "delta") { chars += e.text.length; setPhase({ kind: "generating", chars }); }
      else if (e.type === "done") setPhase({ kind: "done", html: e.html, cached: e.cached, updatedAt: e.updatedAt, ...(e.actions ? { actions: e.actions } : {}) });
      else if (e.type === "failed") setPhase({ kind: "failed", message: e.message });
    });
    return close;
  }, [apiBase, agent, sessionId, run, fresh, mode]);

  const regenerate = () => { setFresh(true); setRun((r) => r + 1); };
  const pick = (k: SessionDashboardKind) => { if (k !== mode) { setFresh(false); setMode(k); } };

  const picker = (
    <div className="seg sd-kind" role="tablist" aria-label="dashboard kind">
      <button type="button" role="tab" aria-selected={mode === "summary"} className={mode === "summary" ? "on" : ""} onClick={() => pick("summary")}>Summary</button>
      <button type="button" role="tab" aria-selected={mode === "report"} className={mode === "report" ? "on" : ""} onClick={() => pick("report")}>Report</button>
    </div>
  );

  if (phase.kind === "connecting") return <div className="obs sd"><div className="sd-head">{picker}</div><div className="obs-muted">Loading {mode}…</div></div>;
  if (phase.kind === "generating") {
    return (
      <div className="obs sd">
        <div className="sd-head">{picker}</div>
        <div className="obs-muted sd-progress">
          Generating {mode}{phase.chars > 0 ? ` — ${Math.round(phase.chars / 100) / 10}k chars` : ""}… first render drives the local
          agent and can take a couple of minutes; it's cached afterward.
        </div>
      </div>
    );
  }
  if (phase.kind === "failed") {
    return (
      <div className="obs sd">
        <div className="sd-head">{picker}</div>
        <div className="obs-error">{phase.message}</div>
        <button type="button" className="obs-open-transcript sd-regen" onClick={regenerate}>Try again</button>
      </div>
    );
  }

  return (
    <div className="obs sd">
      <div className="sd-head">
        {picker}
        <span className="obs-muted">
          {phase.cached ? "cached · " : ""}generated {fmtTime(phase.updatedAt)}
        </span>
        <button type="button" className="obs-open-transcript sd-regen" onClick={regenerate}>Regenerate</button>
      </div>
      <iframe
        className={"sd-frame" + (mode === "report" ? " is-report" : "")}
        title={mode === "report" ? "Session report" : "Session dashboard"}
        sandbox="allow-scripts"
        srcDoc={sandboxDoc(phase.html)}
      />
      {mode === "report" && phase.actions && phase.actions.length > 0 && (
        <ActionStrip apiBase={apiBase} agent={agent} sessionId={sessionId} actions={phase.actions} />
      )}
    </div>
  );
}

// The feedback loop: the report's deterministic findings, each with its advice,
// plus one wired CTA — distill this session into installable gems (skill drafts
// + lessons via the existing pipeline and cards). Findings inform; the distill
// pass turns them into artifacts the next session actually loads.
function ActionStrip({ apiBase, agent, sessionId, actions }: {
  apiBase: string; agent: "claude" | "codex"; sessionId: string; actions: RecommendedAction[];
}) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [drafts, setDrafts] = useState<DistilledSkill[]>([]);
  const [lessons, setLessons] = useState<DistilledLesson[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const distill = () => {
    setState("running"); setErr(null);
    inspectDistillRoute.call(makeClient(apiBase), { body: { id: sessionId, agent } })
      .then((r) => { setDrafts(r.distilled); setLessons(r.lessons); setDegraded(r.degraded); setState("done"); })
      .catch((e) => { setErr(String(e?.message ?? e)); setState("error"); });
  };

  return (
    <div className="sd-actions">
      <div className="rail-h">Recommended actions</div>
      <ul className="sd-action-list">
        {actions.map((a) => (
          <li key={a.id} className={"sd-action is-" + a.severity}>
            <b>{a.title}</b>
            {a.occurrences > 1 && <span className="obs-muted"> ×{a.occurrences}</span>}
            <div className="obs-muted">{a.advice}</div>
          </li>
        ))}
      </ul>
      {agent === "claude" && (
        <div className="sd-act-cta">
          <button type="button" className="tv-distill-btn" onClick={distill} disabled={state === "running"}>
            {state === "running" ? "Distilling…" : "✦ Turn this session into gems"}
          </button>
          {state === "error" && <span className="obs-error tv-distill-note">{err}</span>}
          {state === "done" && degraded && (
            <span className="obs-muted tv-distill-note">Heuristic draft — no local agent ran; start a Claude ACP agent for richer distillation.</span>
          )}
          {state === "done" && drafts.length === 0 && lessons.length === 0 && (
            <span className="obs-muted tv-distill-note">No distillable procedure or lesson found in this session.</span>
          )}
        </div>
      )}
      {drafts.map((d) => <DraftCard key={d.name} apiBase={apiBase} draft={d} />)}
      {lessons.map((l) => <LessonCard key={l.name} apiBase={apiBase} lesson={l} />)}
    </div>
  );
}

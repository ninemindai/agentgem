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

// The two detector ids whose findings the guardrail pipeline understands
// (guardrails.ts GUARDRAIL_IDS): these route to the Dream review queue instead
// of the lesson distiller.
const GUARDRAIL_ACTION_IDS = new Set(["repeated-tool-error", "tool-rejection"]);

type ActState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "queued"; enqueued: number }
  | { kind: "error"; message: string };

// The feedback loop: the report's deterministic findings, each with a wired
// next step — rejection/error findings enqueue a guardrail into the Dream
// review queue (deterministic, instant); everything else can mint a lesson
// gem targeted at exactly that weakness via the focused distill pass. The
// whole-session distill CTA stays for the broad sweep.
function ActionStrip({ apiBase, agent, sessionId, actions }: {
  apiBase: string; agent: "claude" | "codex"; sessionId: string; actions: RecommendedAction[];
}) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [runningId, setRunningId] = useState<string | null>(null);   // which action's lesson pass is running
  const [drafts, setDrafts] = useState<DistilledSkill[]>([]);
  const [lessons, setLessons] = useState<DistilledLesson[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [queueState, setQueueState] = useState<Record<string, ActState>>({});

  const distill = (focus?: string, actionId?: string) => {
    setState("running"); setErr(null); setRunningId(actionId ?? null);
    inspectDistillRoute.call(makeClient(apiBase), { body: { id: sessionId, agent, ...(focus ? { focus } : {}) } })
      .then((r) => { setDrafts(r.distilled); setLessons(r.lessons); setDegraded(r.degraded); setState("done"); })
      .catch((e) => { setErr(String(e?.message ?? e)); setState("error"); })
      .finally(() => setRunningId(null));
  };

  // Deterministic fast path: run only the guardrail detectors over this session
  // and land the drafts in the Dream review queue (accept writes CLAUDE.md there).
  const queueGuardrail = (actionId: string) => {
    setQueueState((s) => ({ ...s, [actionId]: { kind: "running" } }));
    fetch(`${apiBase}/api/dream/learn`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sessionId, only: "guardrails" }),
    })
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<{ enqueued: number }>; })
      .then((r) => setQueueState((s) => ({ ...s, [actionId]: { kind: "queued", enqueued: r.enqueued } })))
      .catch((e) => setQueueState((s) => ({ ...s, [actionId]: { kind: "error", message: String(e?.message ?? e) } })));
  };

  return (
    <div className="sd-actions">
      <div className="rail-h">Recommended actions</div>
      <ul className="sd-action-list">
        {actions.map((a) => {
          const qs = queueState[a.id] ?? { kind: "idle" };
          const guardrail = GUARDRAIL_ACTION_IDS.has(a.id);
          return (
            <li key={a.id} className={"sd-action is-" + a.severity}>
              <b>{a.title}</b>
              {a.occurrences > 1 && <span className="obs-muted"> ×{a.occurrences}</span>}
              <div className="obs-muted">{a.advice}</div>
              {agent === "claude" && (
                <div className="sd-action-do">
                  {guardrail ? (
                    qs.kind === "queued" ? (
                      <span className="obs-muted">
                        {qs.enqueued > 0 ? `queued ${qs.enqueued} for review` : "already in the queue"} ·{" "}
                        <a href="#/dreaming">Review in Journey ↗</a>
                      </span>
                    ) : (
                      <>
                        <button type="button" className="obs-open-transcript" onClick={() => queueGuardrail(a.id)} disabled={qs.kind === "running"}>
                          {qs.kind === "running" ? "Queuing…" : "Queue guardrail"}
                        </button>
                        {qs.kind === "error" && <span className="obs-error tv-distill-note">{qs.message}</span>}
                      </>
                    )
                  ) : (
                    <button type="button" className="obs-open-transcript" onClick={() => distill(`${a.title}: ${a.advice}`, a.id)} disabled={state === "running"}>
                      {runningId === a.id ? "Distilling…" : "✦ Distill a lesson for this"}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {agent === "claude" && (
        <div className="sd-act-cta">
          <button type="button" className="tv-distill-btn" onClick={() => distill()} disabled={state === "running"}>
            {state === "running" && runningId === null ? "Distilling…" : "✦ Turn this session into gems"}
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

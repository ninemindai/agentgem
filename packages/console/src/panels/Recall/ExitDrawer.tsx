// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from "react";
import { recallRunRoute, recallCancelRoute, makeClient } from "../../api/routes.js";
import { openRecallStream, type RecallFunnelEvent } from "./recallStream.js";
import { ReportActions } from "../../report/ReportActions.js";
import { blocksToMarkdown, blocksToHtml, momentsReportToBlocks } from "../../report/serialize.js";

export interface SessionRef { sessionId: string; agent: string }

interface ChipState { agent: string; started: boolean; answered?: boolean }
type Capped = { scanned: number; requested: number; cap: number };
type FunnelPhase = "running" | "done" | "cancelled" | "failed";

interface RunState {
  prompt: string;
  chips: Map<string, ChipState>;
  synthesis: string;
  capped: Capped | null;
  answers: { sessionId: string; agent: string; answered: boolean; answer: string }[];
  phase: FunnelPhase;
  error?: string;
}

function freshRun(prompt: string, sessions: SessionRef[]): RunState {
  const chips = new Map<string, ChipState>();
  for (const s of sessions) chips.set(s.sessionId, { agent: s.agent, started: false });
  return { prompt, chips, synthesis: "", capped: null, answers: [], phase: "running" };
}

function applyEvent(run: RunState, e: RecallFunnelEvent): RunState {
  switch (e.type) {
    case "session_started": {
      const chips = new Map(run.chips);
      const c = chips.get(e.sessionId);
      chips.set(e.sessionId, { agent: c?.agent ?? "", started: true, answered: c?.answered });
      return { ...run, chips };
    }
    case "session_done": {
      const chips = new Map(run.chips);
      const c = chips.get(e.sessionId);
      chips.set(e.sessionId, { agent: c?.agent ?? "", started: true, answered: e.answered });
      return { ...run, chips };
    }
    case "capped":
      return { ...run, capped: { scanned: e.scanned, requested: e.requested, cap: e.cap } };
    case "synthesis_delta":
      return { ...run, synthesis: run.synthesis + e.text };
    case "done":
      return { ...run, phase: "done", answers: e.answers, synthesis: e.synthesis };
    case "cancelled":
      return { ...run, phase: "cancelled" };
    case "failed":
      return { ...run, phase: "failed", error: e.error };
    default:
      return run;
  }
}

function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 10) + "…" : id;
}

/** The funnel progress line shared by both exits: how many of the selected
 *  sessions have answered so far, plus a "scanned wider than requested" note
 *  once a `capped` event arrives. */
function FunnelLine({ chips, total, capped, phase }: { chips: Map<string, ChipState>; total: number; capped: Capped | null; phase: FunnelPhase }) {
  const done = [...chips.values()].filter((c) => c.answered !== undefined).length;
  return (
    <div className="rc-funnel">
      {phase === "running" && <span className="spark" aria-hidden="true" />}
      Interrogated <b>{done} of {total}</b> selected session{total === 1 ? "" : "s"}
      {phase === "running" && " · synthesizing"}
      {capped && (
        <span className="widen">scanned {capped.scanned} of {capped.requested} — capped at {capped.cap}</span>
      )}
    </div>
  );
}

function ToolRow({ sessions, chips }: { sessions: SessionRef[]; chips: Map<string, ChipState> }) {
  return (
    <div className="rc-toolrow">
      {sessions.map((s) => {
        const c = chips.get(s.sessionId);
        const mark = c?.answered === true ? "✓" : c?.answered === false ? "✗" : c?.started ? "…" : "·";
        const cls = "rc-tool" + (c?.answered === true ? " ok" : c?.answered === false ? " is-failed" : "");
        return (
          <span key={s.sessionId} className={cls}>
            {mark} ask_session <b>{s.agent} · {shortId(s.sessionId)}</b>
          </span>
        );
      })}
    </div>
  );
}

/** Chat exit: a running conversation over the selected sessions. Each send
 *  starts a fresh funnel over the SAME sessions; prior turns stay visible as
 *  history (own toolrow snapshot + agent reply) below the latest funnel line. */
function ChatBody({ sessions, turns, onSend }: { sessions: SessionRef[]; turns: RunState[]; onSend: (prompt: string) => void }) {
  const [draft, setDraft] = useState("");
  const last = turns[turns.length - 1];
  const running = last?.phase === "running";
  const send = () => {
    const prompt = draft.trim();
    if (!prompt) return;
    onSend(prompt);
    setDraft("");
  };
  return (
    <>
      {turns.length === 0 && (
        <p className="rc-emptywork">Ask a question to start interrogating these {sessions.length} sessions.</p>
      )}
      {last && <FunnelLine chips={last.chips} total={sessions.length} capped={last.capped} phase={last.phase} />}
      <div className="rc-chat">
        {turns.map((t, i) => (
          <div key={i}>
            <div className="rc-msg rc-msg--user">{t.prompt}</div>
            <ToolRow sessions={sessions} chips={t.chips} />
            {t.error && <p className="ledger-error">{t.error}</p>}
            {t.synthesis && <div className="rc-msg rc-msg--agent">{t.synthesis}</div>}
          </div>
        ))}
        <div className="rc-composer">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Ask a follow-up across these ${sessions.length} sessions…`}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          />
          <button type="button" className="rc-btn rc-btn--primary" onClick={send} disabled={running}>Send</button>
        </div>
      </div>
    </>
  );
}

/** Extract exit: one query → one funnel → one report, built from the funnel's
 *  final answers + synthesis via momentsReportToBlocks. */
function csvField(value: string): string {
  return /["\n,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function answersToCsv(answers: RunState["answers"]): string {
  const header = ["session", "agent", "answered", "answer"].join(",");
  const rows = answers.map((a) =>
    [a.sessionId, a.agent, String(a.answered), a.answer].map(csvField).join(","));
  return [header, ...rows].join("\n");
}

function ExtractBody({ sessions, run, onExtract }: { sessions: SessionRef[]; run: RunState | null; onExtract: (prompt: string) => void }) {
  const [query, setQuery] = useState("");
  const running = run?.phase === "running";
  const extract = () => {
    const prompt = query.trim();
    if (prompt) { onExtract(prompt); setQuery(""); }
  };
  const answered = (run?.answers ?? []).filter((a) => a.answered && a.answer);
  const md = run ? blocksToMarkdown(momentsReportToBlocks(run.prompt, run.answers, run.synthesis)) : "";
  const html = run ? blocksToHtml(momentsReportToBlocks(run.prompt, run.answers, run.synthesis), "Recall extract") : "";
  const json = run ? JSON.stringify({ prompt: run.prompt, answers: run.answers, synthesis: run.synthesis }) : "";
  const csv = run ? answersToCsv(run.answers) : "";

  return (
    <>
      <div className="rc-extract-q">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What do you want extracted across these sessions?"
          onKeyDown={(e) => { if (e.key === "Enter") extract(); }}
        />
        <button type="button" className="rc-btn rc-btn--primary" onClick={extract} disabled={running}>Extract</button>
      </div>
      {run && <FunnelLine chips={run.chips} total={sessions.length} capped={run.capped} phase={run.phase} />}
      {run && <ToolRow sessions={sessions} chips={run.chips} />}
      {run?.error && <p className="ledger-error">{run.error}</p>}
      {run?.phase === "done" && (
        <div className="rc-report">
          <div className="rc-report-syn"><b>Synthesis.</b> {run.synthesis}</div>
          {answered.length > 0 && (
            <ul className="rc-findings">
              {answered.map((a) => (
                <li className="rc-finding" key={a.sessionId}>
                  <div className="rc-finding-src">{a.agent}<span>{shortId(a.sessionId)}</span></div>
                  <div className="rc-finding-body">{a.answer}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {run?.phase === "done" && (
        <ReportActions title="Recall extract" filename="recall-extract" markdown={md} json={json} html={html} csv={csv} />
      )}
    </>
  );
}

/** The drawer that runs the funnel behind both exits (Chat + Extract) and
 *  renders the result. One `RunState` per in-flight/finished funnel call;
 *  chat keeps a history of turns, extract keeps only the latest. */
export function ExitDrawer({ mode, sessions, apiBase, onClose }: {
  mode: "chat" | "extract"; sessions: SessionRef[]; apiBase: string; onClose: () => void;
}) {
  const [turns, setTurns] = useState<RunState[]>([]);
  const [extractRun, setExtractRun] = useState<RunState | null>(null);
  const closeStreamRef = useRef<(() => void) | null>(null);
  const jobIdRef = useRef<string | null>(null);
  // `aliveRef` guards state writes after unmount; `genRef` tags each run() call
  // so a stale (unmounted or superseded) POST/stream can't drive the wrong turn.
  const aliveRef = useRef(true);
  const genRef = useRef(0);

  const applyToCurrent = (fn: (r: RunState) => RunState) => {
    if (mode === "chat") {
      setTurns((prev) => {
        if (prev.length === 0) return prev;
        const next = prev.slice();
        next[next.length - 1] = fn(next[next.length - 1]);
        return next;
      });
    } else {
      setExtractRun((prev) => (prev ? fn(prev) : prev));
    }
  };

  const teardown = () => {
    closeStreamRef.current?.();
    closeStreamRef.current = null;
    if (jobIdRef.current) {
      const jobId = jobIdRef.current;
      jobIdRef.current = null;
      void recallCancelRoute.call(makeClient(apiBase), { path: { jobId } }).catch(() => { /* best-effort */ });
    }
  };

  useEffect(() => () => { aliveRef.current = false; teardown(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- teardown-only unmount cleanup

  const run = (prompt: string) => {
    teardown();
    const gen = ++genRef.current;
    const fresh = freshRun(prompt, sessions);
    if (mode === "chat") setTurns((prev) => [...prev, fresh]);
    else setExtractRun(fresh);

    recallRunRoute
      .call(makeClient(apiBase), { body: { sessionIds: sessions, prompt, mode } })
      .then(({ jobId }) => {
        // Unmounted, or a newer run() has already started: this job is orphaned
        // as far as this component is concerned — cancel it and don't open a
        // stream, rather than racing a stale singleton ref into place.
        if (!aliveRef.current || genRef.current !== gen) {
          void recallCancelRoute.call(makeClient(apiBase), { path: { jobId } }).catch(() => { /* best-effort */ });
          return;
        }
        jobIdRef.current = jobId;
        closeStreamRef.current = openRecallStream(apiBase, jobId, (e) => {
          if (!aliveRef.current || genRef.current !== gen) return;
          if (e.type === "done" || e.type === "cancelled" || e.type === "failed") jobIdRef.current = null;
          applyToCurrent((r) => applyEvent(r, e));
        });
      })
      .catch((err: unknown) => {
        if (!aliveRef.current || genRef.current !== gen) return;
        const message = err instanceof Error ? err.message : String(err);
        applyToCurrent((r) => ({ ...r, phase: "failed", error: message }));
      });
  };

  const handleClose = () => { teardown(); onClose(); };

  const agents = [...new Set(sessions.map((s) => s.agent))];

  return (
    <section className="rc-work">
      <div className="rc-work-head">
        <span className="rc-work-kind">{mode === "chat" ? "Exit A · Conversation" : "Exit D · Batch extraction"}</span>
        <span className="rc-work-title">
          {mode === "chat" ? `Chatting with ${sessions.length} sessions` : `Extract across ${sessions.length} sessions`}
        </span>
        <span className="rc-work-scope">{agents.join(", ")} · read-only</span>
        <button type="button" className="rc-work-close" onClick={handleClose} aria-label="Close">×</button>
      </div>
      <div className="rc-work-body">
        {mode === "chat"
          ? <ChatBody sessions={sessions} turns={turns} onSend={run} />
          : <ExtractBody sessions={sessions} run={extractRun} onExtract={run} />}
      </div>
    </section>
  );
}

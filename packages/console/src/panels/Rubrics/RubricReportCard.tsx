// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Rubrics/RubricReportCard.tsx

import { useRef, useState, useMemo } from "react";
import type { Client } from "@agentback/client";
import {
  calibrationLine, postRubricVerdict, verdictKeyOf, VERDICT_LABELS,
  type PerSessionRow, type RubricReportView, type RubricFactorView,
  type VerdictValueView, type FactorCalibrationView,
} from "./rubricStream.js";
import { HygieneLeaderboard } from "./HygieneLeaderboard.js";
import { FactorSessionList } from "./FactorSessionList.js";

// What one factor row says on the right-hand side. A criterion carries a denominator
// (how many judged sessions it could apply to) and a cheap detector does not, so the
// two read differently on purpose: "no findings" from a check that was never exercised
// is a false all-clear, and the row must say so instead.
function factorTally(f: RubricFactorView): string {
  const fired = f.count > 0;
  const plural = (n: number) => `${n} session${n === 1 ? "" : "s"}`;
  if (f.applicableSessions === undefined) {
    return fired ? `${f.count} in ${plural(f.sessions)}` : "no findings";
  }
  // Fired first. A fire can come from a session outside the denominator (one that
  // was clipped, say), and claiming "did not apply" next to a finding's advice reads
  // as a contradiction. Only quote the denominator when there actually is one.
  if (fired) {
    return f.applicableSessions > 0
      ? `${f.count} in ${f.sessions} of ${f.applicableSessions} applicable`
      : `${f.count} in ${plural(f.sessions)}`;
  }
  if (f.applicableSessions === 0) return "did not apply to any checked session";
  return `no findings in ${f.applicableSessions} applicable ${f.applicableSessions === 1 ? "session" : "sessions"}`;
}

function FactorRow({
  f, sessionId, current, currentNote, calibration, onRecord, onNote, failed,
  fires, truncated, verdictFor, noteFor, onRecordFor, onNoteFor, failedIds,
}: {
  f: RubricFactorView;
  // Present only at session scope, where this row maps to exactly one session and a
  // (sessionId, factorId) verdict key is unambiguous.
  sessionId?: string;
  current?: VerdictValueView;
  // Seeds the note input on mount — the stored note if one exists, else undefined
  // (empty). The input is otherwise uncontrolled: typing doesn't re-render the row.
  currentNote?: string;
  // The live count: the parent's patched value after a click, else the server's.
  // Passed in rather than read off `f` so a click updates the rate immediately.
  calibration?: FactorCalibrationView;
  onRecord?: (factorId: string, verdict: VerdictValueView) => void;
  onNote?: (factorId: string, verdict: VerdictValueView, note: string) => void;
  // This row's own failed-write flag — NOT a card-level flag, so one row's failure
  // doesn't disappear the moment a different row's call succeeds.
  failed?: boolean;
  // The sessions this factor fired in, already filtered and sorted. Present only at
  // project/all scope — at session scope the row IS the session and carries its own
  // buttons instead.
  fires?: PerSessionRow[];
  // No `summarySessions` prop: the row already has `f.sessions` and passes that
  // straight through. A second copy would be a dead prop.
  truncated?: boolean;
  verdictFor?: (sessionId: string) => VerdictValueView | undefined;
  noteFor?: (sessionId: string) => string | undefined;
  onRecordFor?: (sessionId: string, factorId: string, verdict: VerdictValueView) => void;
  onNoteFor?: (sessionId: string, factorId: string, verdict: VerdictValueView, note: string) => void;
  failedIds?: ReadonlySet<string>;
}) {
  const fired = f.count > 0;
  // A check that never applied is neither a pass nor a problem — don't give it the tick.
  const inapplicable = f.applicableSessions === 0;
  const icon = inapplicable ? "–" : !fired ? "✓" : f.severity === "warn" ? "⚠" : "ℹ";
  const cls = inapplicable ? "rub-na" : !fired ? "rub-ok" : f.severity === "warn" ? "rub-warn" : "rub-info";
  // No call to make on a row that did not fire, outside session scope (see
  // sessionId's doc above), or with no write handler wired — a control that
  // cannot act must not appear.
  const canCall = fired && !!sessionId && !!onRecord;
  const [open, setOpen] = useState(false);
  // Expansion is the project/all-scope path to a verdict. It needs fires to show and
  // a write handler to be worth showing — a control that cannot act must not appear.
  const canExpand = fired && !canCall && !!fires?.length && !!onRecordFor;
  const unreviewed = fires?.filter((r) => !verdictFor?.(r.sessionId)).length ?? 0;
  // Fires are missing from the payload — not merely unshown in this batch — when the
  // report's 200-row cap (across all factors) clipped this factor's own rows below its
  // summary count. Matches the footer's condition (FactorSessionList) exactly: a number
  // must never imply coverage it does not have, and that rule governs this collapsed
  // label too, since it's what shows while the fires themselves are hidden.
  const firesMissing = !!truncated && f.sessions > (fires?.length ?? 0);
  const toggleLabel = unreviewed > 0
    ? `${unreviewed} unreviewed`
    : firesMissing ? `all ${fires?.length ?? 0} shown reviewed` : "all reviewed";
  const fireListId = `rub-fires-${f.id}`;
  // Tracks the note text last sent to the server, so blur only re-POSTs on an actual
  // edit — not on every blur of an untouched (or re-blurred) field.
  const lastPosted = useRef(currentNote ?? "");
  return (
    <li className={"rub-factor " + cls}>
      <div className="rub-factor-head">
        <span className="rub-icon" aria-hidden="true">{icon}</span>
        <span className="analyze-include-name">{f.title}</span>
        <span className="targets-label" style={{ marginLeft: "auto" }}>{factorTally(f)}</span>
      </div>
      {fired && <p className="rub-advice">→ {f.advice}</p>}
      {calibration && (
        <p className="rub-calib">
          {calibrationLine(calibration)}
          {/* Say what the number is not. It counts only fires someone reviewed, so it
              cannot see a criterion that failed to fire when it should have. */}
          <span className="rub-calib-caveat"> · of reviewed fires only</span>
        </p>
      )}
      {canCall && (
        <div className="rub-call-actions" role="group" aria-label={`Your call on ${f.title}`}>
          {VERDICT_LABELS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={"rub-call-btn" + (current === value ? " is-on" : "")}
              aria-pressed={current === value}
              onClick={() => onRecord?.(f.id, value)}
            >{label}</button>
          ))}
          {/* Revealed only once a verdict is chosen, not up front — the gesture has to
              stay one keystroke (click a verdict) or it won't be used (spec §5). */}
          {current && (
            <input
              type="text"
              className="rub-call-note"
              maxLength={500}
              placeholder="why? (optional)"
              aria-label={`Note on ${f.title}`}
              defaultValue={currentNote ?? ""}
              onBlur={(e) => {
                const text = e.target.value;
                if (text === lastPosted.current) return;
                lastPosted.current = text;
                // Re-POST the SAME verdict with the note attached — the store is
                // append-only and latest-wins, so a second row is correct here.
                onNote?.(f.id, current, text);
              }}
            />
          )}
        </div>
      )}
      {failed && <p className="insights-hint">That call was not saved — check the console log and try again.</p>}
      {canExpand && (
        <button
          type="button"
          className="rub-fire-toggle"
          aria-expanded={open}
          aria-controls={fireListId}
          aria-label={`Sessions where ${f.title} fired — ${toggleLabel}`}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> {toggleLabel}
        </button>
      )}
      {canExpand && open && (
        <FactorSessionList
          id={fireListId}
          factorId={f.id}
          rows={fires!}
          summarySessions={f.sessions}
          truncated={!!truncated}
          verdictFor={verdictFor!}
          noteFor={noteFor!}
          onRecord={onRecordFor!}
          onNote={onNoteFor!}
          failedIds={failedIds!}
        />
      )}
    </li>
  );
}

export function RubricReportCard({ report, sessionId, client }: {
  report: RubricReportView;
  sessionId?: string;
  client?: Client;
}) {
  const total = report.factors.length;
  const actionable = report.factors.filter((f) => f.count > 0).length;
  const affected = report.perSession?.length ?? 0;
  const cov = report.judgeCoverage;
  // Verdicts are only unambiguous at session scope (see FactorRow).
  const callable = report.scope === "session" ? sessionId : undefined;
  const stored = report.perSession?.find((s) => s.sessionId === callable)?.verdicts;
  // One pass over perSession per render, not one per factor per render. Sorted here
  // so FactorSessionList stays presentational and the order is testable without a DOM.
  const firesByFactor = useMemo(() => {
    const out = new Map<string, PerSessionRow[]>();
    for (const row of report.perSession ?? []) {
      for (const f of row.factors) {
        if (f.count <= 0) continue;
        const list = out.get(f.id) ?? [];
        list.push(row);
        out.set(f.id, list);
      }
    }
    const countIn = (row: PerSessionRow, id: string) => row.factors.find((f) => f.id === id)?.count ?? 0;
    for (const [id, list] of out) {
      // Worst-first, ties broken on sessionId so the order is total and stable.
      list.sort((a, b) => countIn(b, id) - countIn(a, id) || a.sessionId.localeCompare(b.sessionId));
    }
    return out;
  }, [report.perSession]);
  const [calls, setCalls] = useState<Record<string, VerdictValueView>>({});
  // Calibration patched from the POST response. Without this the button flips but the
  // rate beside it keeps the pre-click count until the next report fetch, which reads
  // as a write that did not take.
  const [rates, setRates] = useState<Record<string, FactorCalibrationView>>({});
  // Keyed by `${sessionId}\u0000${factorId}`, not by factor alone — the same factor
  // has a row per session, and a factor-keyed flag would light up every sibling.
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());

  const record = (sessionId: string, factorId: string, verdict: VerdictValueView, note?: string) => {
    if (!client) return;
    // Keyed on BOTH halves: the same factor now has a row per session, so a
    // factorId-only key would bleed one row's optimistic value onto its siblings.
    const key = verdictKeyOf(sessionId, factorId);
    const prev = calls[key];
    setCalls((c) => ({ ...c, [key]: verdict }));   // optimistic
    setFailedIds((s) => (s.has(key) ? new Set([...s].filter((k) => k !== key)) : s));
    const body: { sessionId: string; factorId: string; rubricId: string; verdict: VerdictValueView; note?: string } =
      { sessionId, factorId, rubricId: report.rubricId, verdict };
    if (note !== undefined) body.note = note;
    postRubricVerdict(client, body)
      // Calibration stays keyed by factor — it is a per-factor number, not per-row.
      .then((r) => setRates((m) => ({ ...m, [factorId]: r.calibration })))
      .catch(() => {
        // A dropped verdict is user input lost — roll back and say so rather than
        // leaving the button looking saved.
        setCalls((c) => { const n = { ...c }; if (prev) n[key] = prev; else delete n[key]; return n; });
        setFailedIds((s) => new Set(s).add(key));
      });
  };
  return (
    <div className="insights-report">
      {/* Verdict line — advice-first: what needs action, not a score. */}
      <p className="rub-verdict">
        <strong>{report.rubricId}</strong> · {report.scope} · {report.sessionsScanned} session{report.sessionsScanned === 1 ? "" : "s"} ·{" "}
        {report.clean
          ? <span className="rub-clean">clean — all {total} check{total === 1 ? "" : "s"} passed</span>
          : actionable > 0
            ? <span className="rub-needs">{actionable} of {total} check{total === 1 ? "" : "s"} need action</span>
            // Nothing fired, but `clean` was withheld — criteria went unevaluated
            // (agent down, or the cap sampled). Saying "0 of N need action" would
            // read as a pass; saying "clean" would overstate what was checked.
            : <span className="rub-needs">{cov?.sampled
                ? `no findings in the ${cov.judged} of ${cov.eligible} sessions checked`
                : "no findings — but some checks did not run"}</span>}
      </p>
      {cov?.sampled && (
        <p className="insights-hint">
          LLM criteria were evaluated on the {cov.judged} most-recent of {cov.eligible} eligible sessions — an
          unchecked session could still trip one. Cheap factors ran over all {report.sessionsScanned}.
        </p>
      )}
      {!!cov?.truncated && (
        <p className="insights-hint">
          {cov.truncated} session{cov.truncated === 1 ? " was" : "s were"} too long to show the judge in full, so
          only the opening steps were checked. Those sessions are left out of every criterion&apos;s denominator.
        </p>
      )}
      {report.hygiene && (
        <p className={"hyg-verdict is-" + report.hygiene.verdict}>
          <span className="hyg-word">{report.hygiene.verdict}</span> <span className="hyg-score">{report.hygiene.score}</span>
        </p>
      )}
      {report.degraded && (
        <p className="insights-hint">Some LLM criteria were skipped — the local agent was unavailable. Cheap-factor results are shown.</p>
      )}
      {report.calibrationUnavailable && (
        // Not the same as "no verdicts yet" — say which one it is. The same store
        // outage also hides `perSession[].verdicts`, so a factor you already called
        // renders with every button unpressed — indistinguishable from never having
        // called it (spec §1.9) unless the banner says so too. It also inflates every
        // expansion's "unreviewed" count the same way, since that count is derived
        // from the same missing verdicts — say that too, rather than a second banner.
        <p className="insights-hint">
          Calibration unavailable — the verdict store could not be read. Findings are unaffected, but any calls you
          already made on this report won&apos;t show as pressed, and unreviewed counts may overstate what&apos;s
          left to judge, until the store is back.
        </p>
      )}

      <ul className="rub-factors">
        {report.factors.map((f) => {
          // Only session scope has a single unambiguous session for the aggregate row.
          const rowKey = callable ? verdictKeyOf(callable, f.id) : undefined;
          return (
            <FactorRow
              key={f.id}
              f={f}
              sessionId={callable}
              current={(rowKey ? calls[rowKey] : undefined) ?? stored?.[f.id]?.verdict}
              currentNote={stored?.[f.id]?.note}
              calibration={rates[f.id] ?? f.calibration}
              onRecord={client && callable ? (fid, v) => record(callable, fid, v) : undefined}
              onNote={client && callable ? (fid, v, note) => record(callable, fid, v, note) : undefined}
              failed={!!rowKey && failedIds.has(rowKey)}
              fires={firesByFactor.get(f.id)}
              truncated={!!report.perSessionTruncated}
              verdictFor={(sid) => calls[verdictKeyOf(sid, f.id)]
                ?? report.perSession?.find((r) => r.sessionId === sid)?.verdicts?.[f.id]?.verdict}
              noteFor={(sid) => report.perSession?.find((r) => r.sessionId === sid)?.verdicts?.[f.id]?.note}
              onRecordFor={client ? record : undefined}
              onNoteFor={client ? (sid, fid, v, note) => record(sid, fid, v, note) : undefined}
              failedIds={failedIds}
            />
          );
        })}
      </ul>

      {affected > 0 && (
        report.perSession!.some((s) => s.hygiene)
          ? <HygieneLeaderboard perSession={report.perSession!} sessionsScanned={report.sessionsScanned} truncated={!!report.perSessionTruncated} />
          : <p className="insights-hint">
              {affected} session{affected === 1 ? "" : "s"} tripped a factor{report.perSessionTruncated ? " (showing the first 200)" : ""}.
            </p>
      )}
      {report.skippedFactors.length > 0 && (
        <p className="ledger-muted">
          Skipped: {report.skippedFactors.map((s) => `${s.factor} (${s.reason === "llm-phase2" ? "LLM — Phase 2" : "unknown"})`).join(", ")}
        </p>
      )}
    </div>
  );
}

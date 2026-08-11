// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Rubrics/FactorSessionList.tsx
//
// The sessions one factor fired in, each with its own verdict controls. This is what
// lets calibration accumulate at project/all scope, where the fires actually are — a
// factor showing "93 in 65 sessions" here yields 65 reviewable calls, against 3 at
// session scope.
//
// Presentational by contract: `rows` arrive already filtered to this factor and
// already sorted. The component owns nothing but its batch window. Same split as
// HygieneLeaderboard, and it is what makes the sort testable without a DOM.
import { useRef, useState } from "react";
import { VERDICT_LABELS, verdictKeyOf, type PerSessionRow, type VerdictValueView } from "./rubricStream.js";

/** Rows revealed per click. Small on purpose: the point is to start judging, not to scroll. */
const BATCH_SIZE = 10;

function FireRow({ row, factorId, verdict, note, onRecord, onNote, failed }: {
  row: PerSessionRow;
  factorId: string;
  verdict?: VerdictValueView;
  note?: string;
  onRecord: (sessionId: string, factorId: string, verdict: VerdictValueView) => void;
  onNote: (sessionId: string, factorId: string, verdict: VerdictValueView, note: string) => void;
  failed: boolean;
}) {
  const count = row.factors.find((f) => f.id === factorId)?.count ?? 0;
  // Tracks the text last sent, so blur only re-POSTs on an actual edit.
  const lastPosted = useRef(note ?? "");
  return (
    <li className="rub-fire-row" data-testid="rub-fire-row">
      <span className="rub-fire-name">{row.transcript}</span>
      <span className="rub-fire-count">{count}×</span>
      <span className="rub-call-actions" role="group" aria-label={`Your call on ${row.transcript}`}>
        {VERDICT_LABELS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={"rub-call-btn" + (verdict === value ? " is-on" : "")}
            aria-pressed={verdict === value}
            // row.sessionId, never a value closed over from the panel — this row's
            // own session is the only correct half of the key.
            onClick={() => onRecord(row.sessionId, factorId, value)}
          >{label}</button>
        ))}
        {verdict && (
          <input
            type="text"
            className="rub-call-note"
            maxLength={500}
            placeholder="why? (optional)"
            aria-label={`Note on ${row.transcript}`}
            defaultValue={note ?? ""}
            onBlur={(e) => {
              const text = e.target.value;
              if (text === lastPosted.current) return;
              lastPosted.current = text;
              onNote(row.sessionId, factorId, verdict, text);
            }}
          />
        )}
      </span>
      {failed && <span className="rub-fire-failed">not saved — try again</span>}
    </li>
  );
}

export function FactorSessionList({
  id, factorId, rows, summarySessions, truncated, verdictFor, noteFor, onRecord, onNote, failedIds,
}: {
  /** DOM id for the outer container — the toggle button's `aria-controls` targets this. */
  id?: string;
  factorId: string;
  /** Already filtered to this factor's fires and already sorted. */
  rows: PerSessionRow[];
  /** The factor summary's `sessions` — the number the cap is measured against. */
  summarySessions: number;
  /** report.perSessionTruncated: the report's 200-row cap tripped. */
  truncated: boolean;
  verdictFor: (sessionId: string) => VerdictValueView | undefined;
  noteFor: (sessionId: string) => string | undefined;
  onRecord: (sessionId: string, factorId: string, verdict: VerdictValueView) => void;
  onNote: (sessionId: string, factorId: string, verdict: VerdictValueView, note: string) => void;
  failedIds: ReadonlySet<string>;
}) {
  const [shown, setShown] = useState(BATCH_SIZE);
  const visible = rows.slice(0, shown);
  // Two different truncations, never conflated (spec §4). `available` is what this
  // report carried; `missing` is what the 200-row cap kept it from carrying at all.
  // Saying "showing 3 of 3" while 37 fires were invisible would be the list-shaped
  // version of the denominator the rate itself refuses to quote.
  const available = rows.length;
  const missing = truncated ? Math.max(0, summarySessions - available) : 0;
  return (
    <div className="rub-fire-list" id={id}>
      <ul className="rub-fire-rows">
        {visible.map((row) => (
          <FireRow
            key={row.sessionId}
            row={row}
            factorId={factorId}
            verdict={verdictFor(row.sessionId)}
            note={noteFor(row.sessionId)}
            onRecord={onRecord}
            onNote={onNote}
            failed={failedIds.has(verdictKeyOf(row.sessionId, factorId))}
          />
        ))}
      </ul>
      <p className="rub-fire-footer" data-testid="rub-fire-footer">
        showing {visible.length} of {available} available
        {missing > 0 && <> · {missing} more beyond this report&apos;s 200-session cap</>}
        {shown < available && (
          <button type="button" className="rub-fire-more" onClick={() => setShown((n) => n + BATCH_SIZE)}>
            Show more
          </button>
        )}
      </p>
    </div>
  );
}

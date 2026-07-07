// packages/console/src/panels/Observe/turnTree.tsx
//
// The verbatim turn -> span tree renderer, extracted out of TranscriptViewer so
// StructureView (Map <-> Transcript toggle) can render Transcript mode without a
// circular import: StructureView needs Turn, TranscriptViewer needs StructureView.
import { useState } from "react";
import type { TranscriptTurn, TranscriptSpan } from "../../api/routes.js";
import { fmtTokens } from "./data.js";

export function Turn({ turn, startMs, open, onToggle }: {
  turn: TranscriptTurn; startMs: number; open: boolean; onToggle: () => void;
}) {
  const tok = turn.tokens.in + turn.tokens.out;
  return (
    <li className={"tv-turn role-" + turn.role}>
      <button type="button" className="tv-turn-head" aria-expanded={open} onClick={onToggle}>
        <span className={"obs-caret" + (open ? " open" : "")}>▸</span>
        <span className="tv-role">{turn.role}</span>
        <span className="tv-summary">{summarize(turn)}</span>
        <span className="tv-when obs-muted">{relTime(turn.tsMs - startMs)}</span>
        {tok > 0 && <span className="tv-tok obs-chip">{fmtTokens(tok)}</span>}
      </button>
      {open && (
        <div className="tv-spans">
          {turn.spans.map((span, i) => <Span key={i} span={span} />)}
        </div>
      )}
    </li>
  );
}

export function Span({ span }: { span: TranscriptSpan }) {
  if (span.kind === "message") {
    return <pre className={"tv-msg role-" + span.role}>{span.text}</pre>;
  }
  return <ToolCall span={span} />;
}

function ToolCall({ span }: { span: Extract<TranscriptSpan, { kind: "tool_call" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={"tv-tool" + (span.error ? " is-error" : "")}>
      <button type="button" className="tv-tool-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={"obs-caret" + (open ? " open" : "")}>▸</span>
        <span className="tv-tool-name">{span.name}</span>
        {span.error && <span className="tv-tool-err">error</span>}
      </button>
      {open && (
        <div className="tv-tool-body">
          <div className="tv-tool-label obs-muted">input</div>
          <pre className="tv-io">{span.input}</pre>
          {span.output !== undefined && (
            <>
              <div className="tv-tool-label obs-muted">output</div>
              <pre className="tv-io">{span.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// One-line preview of a turn for the collapsed header.
export function summarize(turn: TranscriptTurn): string {
  const first = turn.spans[0];
  if (!first) return "";
  if (first.kind === "message") return firstLine(first.text);
  const tools = turn.spans.filter((s) => s.kind === "tool_call").map((s) => (s as { name: string }).name);
  return tools.length === 1 ? tools[0] : `${tools.length} tool calls: ${tools.slice(0, 3).join(", ")}`;
}

function firstLine(s: string): string {
  const line = s.split("\n", 1)[0];
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
}

// Relative offset from session start, e.g. "+0s", "+1m12s", "+1h03m".
function relTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `+${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `+${m}m${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `+${h}h${String(rm).padStart(2, "0")}m`;
}

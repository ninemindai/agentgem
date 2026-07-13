import { useMemo, useState } from "react";
import type { InsightsReportView } from "./insightsStream.js";
import { OutcomesDonut, ByModelBars } from "./InsightsCharts.js";
import { useTableSort, type SortColumn } from "../../shell/useTableSort.js";
import { SortTh } from "../../shell/SortTh.js";
import { ReportActions } from "../../report/ReportActions.js";
import { insightsToBlocks, blocksToMarkdown, blocksToHtml } from "../../report/serialize.js";

type PublishCandidate = InsightsReportView["publish_candidates"][number];
// Sortable columns for the "Worth publishing" table (unsorted = report order).
const CANDIDATE_COLUMNS: SortColumn<PublishCandidate>[] = [
  { id: "goal", value: (c) => c.goal.toLowerCase() },
  { id: "why", value: (c) => c.why.toLowerCase() },
];

export function InsightsReportCard({ report, scanned, onBuild, onContribute }: { report: InsightsReportView; scanned?: number | null; onBuild?: () => void; onContribute?: () => void | Promise<void> }) {
  const [contributing, setContributing] = useState(false);
  const [contributeError, setContributeError] = useState<string | null>(null);
  const candidateSort = useTableSort(CANDIDATE_COLUMNS);

  const handleContribute = async () => {
    if (!onContribute) return;
    setContributing(true);
    setContributeError(null);
    try {
      await onContribute();
    } catch (e) {
      setContributeError(e instanceof Error ? e.message : "Prepare failed.");
    } finally {
      setContributing(false);
    }
  };

  // Be honest about the cap: the report judges the most-recent sessions, which
  // can be fewer than were scanned (50-session batch bound, or unmissioned ones).
  const judged = report.totals.sessions;
  const capped = scanned != null && scanned > judged;
  // Defensive: tolerate a malformed/older-shape report (e.g. a stale cache entry
  // missing a field) — a missing array must not crash the whole console.
  const byModel = report.by_model ?? [];
  const publishCandidates = report.publish_candidates ?? [];
  const friction = report.friction ?? [];
  const blocks = useMemo(() => insightsToBlocks(report, scanned), [report, scanned]);
  const markdown = useMemo(() => blocksToMarkdown(blocks), [blocks]);
  const html = useMemo(() => blocksToHtml(blocks, "AgentGem Insights"), [blocks]);
  const json = useMemo(() => JSON.stringify(report, null, 2), [report]);
  return (
    <div className="insights-report">
      <ReportActions title="AgentGem Insights" filename="agentgem-insights" markdown={markdown} json={json} html={html} />
      {report.narrative && <p className="insights-narrative">{report.narrative}</p>}
      <p className="analyze-candidate-desc">{report.outcomes_summary}</p>
      {capped && <p className="insights-hint">Based on the {judged} most-recent of {scanned} sessions scanned.</p>}

      <OutcomesDonut totals={report.totals} />

      {byModel.length > 1 && (
        <div className="insights-section">
          <h4>By model</h4>
          <ByModelBars byModel={byModel} />
          <ul className="insights-bymodel">
            {byModel.map((m) => (
              <li key={m.model}>
                <span className="analyze-include-name">{m.model}</span>
                <span className="insights-rate">{Math.round((m.mostly / m.total) * 100)}% mostly</span>
                <span className="targets-label">{m.total} session{m.total === 1 ? "" : "s"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {publishCandidates.length > 0 && (
        <div className="insights-section">
          <div className="analyze-candidate-head">
            <h4 style={{ margin: 0 }}>Worth publishing</h4>
            {onBuild && <button type="button" className="ledger-build" style={{ marginLeft: "auto" }} onClick={onBuild}>Build a Gem from this project →</button>}
            {onContribute && <button type="button" className="ledger-build" disabled={contributing} onClick={handleContribute}>{contributing ? "Preparing…" : "Publish"}</button>}
          </div>
          {contributeError && <p className="ledger-error">{contributeError}</p>}
          <table className="obs-table insights-candidates">
            <thead><tr>
              <SortTh label="goal" dir={candidateSort.dirFor("goal")} onClick={() => candidateSort.onSort("goal")} />
              <SortTh label="why" dir={candidateSort.dirFor("why")} onClick={() => candidateSort.onSort("why")} />
            </tr></thead>
            <tbody>
              {candidateSort.sort(publishCandidates).map((c) => (
                <tr key={c.sessionId}>
                  <td className="analyze-include-name">{c.goal}</td>
                  <td className="targets-label">{c.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {friction.length > 0 && (
        <div className="insights-section">
          <h4>Friction</h4>
          <ul className="analyze-include">
            {friction.map((f) => (
              <li key={f.sessionId}><span className="analyze-include-name">{f.detail}</span></li>
            ))}
          </ul>
        </div>
      )}

      {publishCandidates.length === 0 && friction.length === 0 && (
        <p className="ledger-empty">No standout sessions yet — keep working and re-run.</p>
      )}
    </div>
  );
}

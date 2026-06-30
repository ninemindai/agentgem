// packages/console/src/panels/Optimize/Dashboard.tsx
import { fmtTokens } from "../Observe/data.js";
import type { OptimizePayload, OptimizeRange } from "../../api/routes.js";
import { RefreshButton } from "../../shell/RefreshButton.js";
import { DiscoverSection } from "./Discover.js";

const RANGES: OptimizeRange[] = ["today", "7d", "30d", "all"];

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function Dashboard({ data, range, onRange, pending, onRefresh, apiBase }: {
  data: OptimizePayload;
  range: OptimizeRange;
  onRange: (r: OptimizeRange) => void;
  pending: boolean;
  onRefresh?: () => void;
  apiBase: string;
}) {
  const prunable = data.artifacts.filter((a) => a.prune);
  const savings = prunable.reduce((acc, a) => acc + a.contextTokens, 0);

  return (
    <div className="opt">
      <div className="opt-head">
        <div className="opt-ranges">
          {RANGES.map((r) => (
            <button key={r} className={"obs-range-btn" + (r === range ? " is-active" : "")} onClick={() => onRange(r)}>{r}</button>
          ))}
        </div>
        {pending && <span className="obs-muted">refreshing…</span>}
        {onRefresh && <RefreshButton onClick={onRefresh} busy={pending} />}
      </div>

      <DiscoverSection apiBase={apiBase} />

      <section className="opt-section">
        <h3>Prune — installed but unused <span className="obs-muted">({prunable.length}, ~{fmtTokens(savings)} est. context saved)</span></h3>
        <p className="obs-muted opt-note">Context tokens are estimates (chars/4). Skills count name+description; MCP counts launch config (tool schemas add more at runtime). Recommend-only — nothing is changed for you.</p>
        <table className="obs-table">
          <thead><tr><th>artifact</th><th>type</th><th>source</th><th>est. ctx</th><th>uses</th><th>last used</th><th>to disable</th></tr></thead>
          <tbody>
            {data.artifacts.map((a) => (
              <tr key={a.type + ":" + a.name} className={a.prune ? "opt-prune" : ""}>
                <td>{a.name}</td>
                <td><span className="obs-chip">{a.type}</span></td>
                <td className="obs-muted">{a.source}</td>
                <td>{fmtTokens(a.contextTokens)}</td>
                <td>{a.uses}</td>
                <td className="obs-muted">{a.lastUsedMs ? utcDay(a.lastUsedMs) : "never"}</td>
                <td><code className="opt-change" title={`${a.change.file} → ${a.change.key}`}>{a.prune ? a.change.key : "—"}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="opt-section">
        <h3>Instructions health <span className="obs-muted">global · loaded every session</span></h3>
        <table className="obs-table">
          <thead><tr><th>file</th><th>source</th><th>est. ctx / session</th><th>lines</th><th>flags</th></tr></thead>
          <tbody>
            {data.instructions.map((i) => (
              <tr key={i.source + ":" + i.name}>
                <td>{i.name}</td>
                <td className="obs-muted">{i.source}</td>
                <td>{fmtTokens(i.contextTokens)}</td>
                <td>{i.lines}</td>
                <td>{i.flags.length ? i.flags.map((f) => <span key={f} className="opt-flag">{f}</span>) : <span className="obs-muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

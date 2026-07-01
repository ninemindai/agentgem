// packages/console/src/panels/Optimize/Dashboard.tsx
import { useState } from "react";
import { fmtTokens } from "../Observe/data.js";
import {
  disableArtifactsRoute, enableArtifactsRoute, makeClient,
  type OptimizePayload, type OptimizeRange, type OptimizeArtifact, type DisabledArtifact,
} from "../../api/routes.js";
import { RefreshButton } from "../../shell/RefreshButton.js";
import { DiscoverSection } from "./Discover.js";

const RANGES: OptimizeRange[] = ["today", "7d", "30d", "all"];

// A prune row is disable-eligible unless it comes from a source we can't reversibly
// deactivate (drafts / project-scoped). Everything else routes to a flag or archive move.
const INELIGIBLE = new Set(["distilled-draft", "project"]);
function eligible(a: OptimizeArtifact): boolean {
  return a.prune && !INELIGIBLE.has(a.source);
}
function key(a: { type: string; name: string; source: string }): string {
  return `${a.type}:${a.source}:${a.name}`;
}

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

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const toggle = (a: OptimizeArtifact) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(key(a)) ? next.delete(key(a)) : next.add(key(a));
    return next;
  });

  const disableSelected = () => {
    const artifacts = data.artifacts.filter((a) => selected.has(key(a)))
      .map((a) => ({ type: a.type, name: a.name, source: a.source }));
    if (!artifacts.length) return;
    setBusy(true); setNote(null);
    disableArtifactsRoute.call(makeClient(apiBase), { body: { artifacts } })
      .then((r) => {
        const failed = r.results.filter((x) => !x.ok);
        setNote(failed.length ? `${failed.length} failed: ${failed.map((f) => `${f.name} (${f.message})`).join("; ")}` : null);
        setSelected(new Set());
        onRefresh?.();
      })
      .catch((e) => setNote(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  const reEnable = (d: DisabledArtifact) => {
    setBusy(true); setNote(null);
    enableArtifactsRoute.call(makeClient(apiBase), { body: { artifacts: [{ type: d.type, name: d.name, source: d.source }] } })
      .then((r) => {
        const f = r.results.find((x) => !x.ok);
        setNote(f ? `${f.name}: ${f.message}` : null);
        onRefresh?.();
      })
      .catch((e) => setNote(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

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
        <p className="obs-muted opt-note">Context tokens are estimates (chars/4). Disable is reversible: plugins/MCP flip a config flag; skills relocate to <code>~/.agentgem/disabled/</code>. Re-enable below.</p>
        <div className="opt-disc-actions">
          <button className="obs-range-btn" onClick={disableSelected} disabled={busy || selected.size === 0}>
            {busy ? "Working…" : `Disable selected (${selected.size})`}
          </button>
          {note && <span className="obs-error" title={note}>{note}</span>}
        </div>
        <table className="obs-table">
          <thead><tr><th></th><th>artifact</th><th>type</th><th>source</th><th>est. ctx</th><th>uses</th><th>last used</th><th>to disable</th></tr></thead>
          <tbody>
            {data.artifacts.map((a) => (
              <tr key={a.type + ":" + a.name} className={a.prune ? "opt-prune" : ""}>
                <td>{eligible(a)
                  ? <input type="checkbox" aria-label={`select ${a.name}`} checked={selected.has(key(a))} onChange={() => toggle(a)} />
                  : null}</td>
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

      {data.disabled.length > 0 && (
        <section className="opt-section">
          <h3>Disabled <span className="obs-muted">({data.disabled.length}) · reversible</span></h3>
          <table className="obs-table">
            <thead><tr><th>artifact</th><th>type</th><th>source</th><th>re-enable</th></tr></thead>
            <tbody>
              {data.disabled.map((d) => (
                <tr key={d.type + ":" + d.source + ":" + d.name}>
                  <td>{d.name}</td>
                  <td><span className="obs-chip">{d.type}</span></td>
                  <td className="obs-muted">{d.source}</td>
                  <td><button className="obs-range-btn" disabled={busy} aria-label={`re-enable ${d.name}`} onClick={() => reEnable(d)}>Re-enable</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

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

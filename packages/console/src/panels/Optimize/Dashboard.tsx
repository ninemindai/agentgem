// packages/console/src/panels/Optimize/Dashboard.tsx
import { useState } from "react";
import { fmtTokens } from "../Observe/data.js";
import {
  disableArtifactsRoute, enableArtifactsRoute, makeClient,
  type OptimizePayload, type OptimizeRange, type OptimizeArtifact, type DisabledArtifact,
} from "../../api/routes.js";
import { RefreshButton } from "../../shell/RefreshButton.js";
import { ListControls } from "../../shell/ListControls.js";
import { useSelectableList } from "../../shell/useSelectableList.js";
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

export function Dashboard({ data, range, onRange, pending, onRefresh, onMutate, apiBase }: {
  data: OptimizePayload;
  range: OptimizeRange;
  onRange: (r: OptimizeRange) => void;
  pending: boolean;
  onRefresh?: () => void;
  // Applies a local, network-free transform to the loaded payload so a disable/
  // re-enable reflects instantly instead of forcing a full re-scan of the panel.
  onMutate?: (fn: (p: OptimizePayload) => OptimizePayload) => void;
  apiBase: string;
}) {
  const prunable = data.artifacts.filter((a) => a.prune);
  const savings = prunable.reduce((acc, a) => acc + a.contextTokens, 0);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [prunableOnly, setPrunableOnly] = useState(false);

  const list = useSelectableList(data.artifacts, {
    keyOf: key,
    eligible,
    matches: (a, q) => a.name.toLowerCase().includes(q) || a.source.toLowerCase().includes(q) || a.type.toLowerCase().includes(q),
    extraFilter: (a) => !prunableOnly || a.prune,
  });
  // Savings for the current selection (across all artifacts, even ones filtered out of view).
  const selectedSavings = list.selectedItems().reduce((acc, a) => acc + a.contextTokens, 0);

  const disableSelected = () => {
    const chosen = list.selectedItems();
    if (!chosen.length) return;
    const artifacts = chosen.map((a) => ({ type: a.type, name: a.name, source: a.source }));
    setBusy(true); setNote(null);
    disableArtifactsRoute.call(makeClient(apiBase), { body: { artifacts } })
      .then((r) => {
        const failed = r.results.filter((x) => !x.ok);
        setNote(failed.length ? `${failed.length} failed: ${failed.map((f) => `${f.name} (${f.message})`).join("; ")}` : null);
        // Move only the ones the server confirmed disabled (result carries type+name).
        const okKeys = new Set(r.results.filter((x) => x.ok).map((x) => `${x.type}:${x.name}`));
        const moved = chosen.filter((a) => okKeys.has(`${a.type}:${a.name}`));
        list.clear();
        if (moved.length) onMutate?.((p) => {
          const movedKeys = new Set(moved.map(key));
          return {
            ...p,
            artifacts: p.artifacts.filter((a) => !movedKeys.has(key(a))),
            disabled: [...p.disabled, ...moved.map((a) => ({ type: a.type, name: a.name, source: a.source }))],
          };
        });
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
        // Drop it from the Disabled list locally. Its prune-table row isn't
        // reconstructible here (we lack token/use counts), so a Refresh re-scans
        // to re-surface it if it's still unused.
        if (!f) onMutate?.((p) => ({
          ...p,
          disabled: p.disabled.filter((x) => !(x.type === d.type && x.name === d.name && x.source === d.source)),
        }));
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
        <ListControls
          query={list.query} onQuery={list.setQuery} label="filter artifacts"
          placeholder="Filter by name, type, or source…"
          selectLabel={list.allSelected ? "Deselect all" : `Select all (${list.eligibleVisible.length})`}
          onSelectAll={list.toggleAll} selectDisabled={list.eligibleVisible.length === 0}
          extras={
            <label className="opt-prunable-only">
              <input type="checkbox" checked={prunableOnly} onChange={(e) => setPrunableOnly(e.target.checked)} />
              prunable only
            </label>
          }
          actions={
            <>
              <button className="obs-range-btn" onClick={disableSelected} disabled={busy || list.selected.size === 0}>
                {busy ? "Working…" : `Disable selected (${list.selected.size})`}
              </button>
              {list.selected.size > 0 && <span className="opt-sel-savings">~{fmtTokens(selectedSavings)} est. context freed</span>}
              {note && <span className="obs-error" title={note}>{note}</span>}
            </>
          }
        />
        <table className="obs-table">
          <thead><tr><th></th><th>artifact</th><th>type</th><th>source</th><th>est. ctx</th><th>uses</th><th>last used</th><th>to disable</th></tr></thead>
          <tbody>
            {list.filtered.length === 0 && (
              <tr><td colSpan={8} className="obs-muted">No artifacts match this filter.</td></tr>
            )}
            {list.filtered.map((a) => (
              <tr key={a.type + ":" + a.name} className={a.prune ? "opt-prune" : ""}>
                <td>{eligible(a)
                  ? <input type="checkbox" aria-label={`select ${a.name}`} checked={list.isSelected(a)} onChange={() => list.toggle(a)} />
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

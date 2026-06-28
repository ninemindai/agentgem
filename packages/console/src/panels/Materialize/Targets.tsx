import { useState } from "react";
import { materializeRoute, makeClient, TARGET_IDS, type MaterializeResult } from "../../api/routes.js";
import type { GemSelection } from "../Curate/selection.js";
import { ContentView } from "../Curate/ContentView.js";

/** File paths in a stable, directory-friendly order. */
export function sortedFiles(files: Record<string, string>): string[] {
  return Object.keys(files).sort((a, b) => a.localeCompare(b));
}

/** Materialize the current selection for a chosen target and browse the output files. */
export function Targets({ apiBase, selection, name }: { apiBase: string; selection: GemSelection; name: string }) {
  const [target, setTarget] = useState<string>("claude");
  const [result, setResult] = useState<MaterializeResult | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const client = makeClient(apiBase);
      const r = await materializeRoute.call(client, { body: { selection, target, name } });
      setResult(r);
      setActive(sortedFiles(r.files)[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const files = result ? sortedFiles(result.files) : [];

  return (
    <div className="targets">
      <div className="targets-bar">
        <span className="targets-label">Materialize for</span>
        <select className="targets-select" aria-label="target" value={target} onChange={(e) => setTarget(e.target.value)}>
          {TARGET_IDS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button type="button" className="ledger-sort" disabled={busy} onClick={run}>
          {busy ? "Materializing…" : "Materialize"}
        </button>
        {error && <span className="ledger-error">{error}</span>}
      </div>

      {result && (
        <>
          <div className="targets-result">
            <ul className="targets-files">
              {files.map((f) => (
                <li
                  key={f}
                  className={"targets-file" + (f === active ? " is-active" : "")}
                  onClick={() => setActive(f)}
                >{f}</li>
              ))}
            </ul>
            <div className="targets-content-wrap">
              {active && active.endsWith(".md")
                ? <ContentView text={result.files[active]} />
                : <pre className="targets-content">{active ? result.files[active] : ""}</pre>}
            </div>
          </div>
          {result.skipped.length > 0 && (
            <p className="targets-skipped">{result.skipped.length} artifact(s) skipped for {result.target}.</p>
          )}
        </>
      )}
    </div>
  );
}

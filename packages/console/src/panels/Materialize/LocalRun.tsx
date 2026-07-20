import { useEffect, useRef, useState } from "react";
import {
  runReadyRoute, runRoute, runStatusRoute, runStopRoute, makeClient, type RunState,
} from "../../api/routes.js";

/** Targets that produce a runnable web app. */
const RUNNABLE = ["eve", "flue"];
const ACTIVE = new Set(["installing", "building", "deploying"]);

// Run the built gem's rendered web-app target locally: re-render into the workspace's
// .run dir, npm-install, build, start, and tail the process output. The sibling of
// <Run> (which runs the gem with a local coding agent) — this one serves the app itself.
export function LocalRun({ apiBase, name }: { apiBase: string; name: string }) {
  const [target, setTarget] = useState<string>("eve");
  const [ready, setReady] = useState<{ local: boolean } | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    setReady(null);
    runReadyRoute.call(makeClient(apiBase), { query: { name, target } })
      .then((r) => { if (alive) setReady(r); })
      .catch(() => { if (alive) setReady(null); });
    return () => { alive = false; };
  }, [apiBase, name, target]);

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  const poll = () => {
    pollRef.current = setTimeout(async () => {
      try {
        const r = await runStatusRoute.call(makeClient(apiBase), { query: { name, target } });
        setRun(r);
        if (r.state === "running" || r.state === "failed") { setBusy(false); return; }
        poll();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    }, 1500);
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    setRun(null);
    try {
      const r = await runRoute.call(makeClient(apiBase), { body: { name, target, mode: "local" } });
      setRun(r);
      if (r.state === "running" || r.state === "failed") setBusy(false);
      else poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const stop = async () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    try { await runStopRoute.call(makeClient(apiBase), { body: { name, target } }); } catch { /* ignore */ }
    setRun(null);
    setBusy(false);
  };

  return (
    <div className="ws-deploy">
      <div className="ws-actions">
        <span className="targets-label">Run app</span>
        <select className="targets-select" aria-label={`run target for ${name}`} value={target} onChange={(e) => setTarget(e.target.value)}>
          {RUNNABLE.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button
          type="button"
          className="ledger-sort"
          disabled={busy || ready?.local !== true}
          title={ready?.local === true ? "" : "local runtime not ready"}
          onClick={() => start()}
        >Run locally</button>
        {busy && <button type="button" className="ws-delete" onClick={stop}>Stop</button>}
      </div>
      {error && <p className="ledger-error">{error}</p>}
      {run && (
        <div className="run-out">
          <div className="run-status">
            <span className={"run-badge " + (run.state === "running" ? "run-done" : run.state === "failed" ? "run-failed" : "run-running")}>{run.state}</span>
            {run.url && <a className="ws-deploy-url" href={run.url} target="_blank" rel="noreferrer">{run.url}</a>}
            {ACTIVE.has(run.state) && <span className="run-phase">{run.mode}…</span>}
          </div>
          {run.logTail.length > 0 && <pre className="run-transcript">{run.logTail.join("\n")}</pre>}
        </div>
      )}
    </div>
  );
}

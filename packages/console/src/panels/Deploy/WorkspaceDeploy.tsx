import { useEffect, useRef, useState } from "react";
import {
  runReadyRoute, runRoute, runStatusRoute, runStopRoute, makeClient, type RunState,
} from "../../api/routes.js";

/** Targets that produce a runnable/deployable web app. */
const RUNNABLE = ["eve", "flue"];
type Mode = "local" | "vercel" | "cloudflare";
type Ready = { local: boolean; vercel: boolean; cloudflare: boolean };

const MODE_LABEL: Record<Mode, string> = { local: "Run locally", vercel: "Deploy to Vercel", cloudflare: "Deploy to Cloudflare" };
const ACTIVE = new Set(["installing", "building", "deploying"]);

export function WorkspaceDeploy({ apiBase, name }: { apiBase: string; name: string }) {
  const [target, setTarget] = useState<string>("eve");
  const [ready, setReady] = useState<Ready | null>(null);
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

  const start = async (mode: Mode) => {
    setBusy(true);
    setError(null);
    setRun(null);
    try {
      const r = await runRoute.call(makeClient(apiBase), { body: { name, target, mode } });
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

  const can = (m: Mode) => ready?.[m] === true;

  return (
    <div className="ws-deploy">
      <div className="ws-actions">
        <span className="targets-label">Deploy</span>
        <select className="targets-select" aria-label={`deploy target for ${name}`} value={target} onChange={(e) => setTarget(e.target.value)}>
          {RUNNABLE.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {(["local", "vercel", "cloudflare"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            className={m === "local" ? "ledger-sort" : "ledger-build"}
            disabled={busy || !can(m)}
            title={can(m) ? "" : "backend not configured"}
            onClick={() => start(m)}
          >{MODE_LABEL[m]}</button>
        ))}
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

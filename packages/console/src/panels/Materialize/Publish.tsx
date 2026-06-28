import { useEffect, useState } from "react";
import {
  publishReadyRoute, publishRoute, undeployRoute, PUBLISH_TARGETS, makeClient,
} from "../../api/routes.js";
import type { GemSelection } from "../Ledger/selection.js";

type Result = { kind: string; agentId?: string; environmentId?: string; version?: string; harnessId?: string };

/** Map a publish target to the undeploy target id. */
const UNDEPLOY: Record<string, "claude-managed" | "agentcore"> = {
  "claude-managed": "claude-managed",
  "agentcore-managed": "agentcore",
};

/** Publish the built selection to a managed backend, with undeploy. */
export function Publish({ apiBase, selection, name }: { apiBase: string; selection: GemSelection; name: string }) {
  const [target, setTarget] = useState<(typeof PUBLISH_TARGETS)[number]>("claude-managed");
  const [ready, setReady] = useState<boolean | null>(null);
  const [wsName, setWsName] = useState(name);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undeployed, setUndeployed] = useState(false);

  useEffect(() => {
    let alive = true;
    setReady(null);
    publishReadyRoute.call(makeClient(apiBase), { query: { target } })
      .then((r) => { if (alive) setReady(r.ready); })
      .catch(() => { if (alive) setReady(false); });
    return () => { alive = false; };
  }, [apiBase, target]);

  const publish = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setUndeployed(false);
    try {
      const requestId = crypto.randomUUID();
      const r = await publishRoute.call(makeClient(apiBase), {
        body: { selection, name, target, requestId, wsName: wsName.trim() || undefined },
      });
      setResult(r as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const undeploy = async () => {
    setBusy(true);
    setError(null);
    try {
      const { removed } = await undeployRoute.call(makeClient(apiBase), { body: { name: wsName.trim(), target: UNDEPLOY[target] } });
      setUndeployed(removed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="publish">
      <div className="ledger-bar">
        <span className="targets-label">Publish</span>
        <select className="targets-select" aria-label="publish target" value={target} onChange={(e) => setTarget(e.target.value as (typeof PUBLISH_TARGETS)[number])}>
          {PUBLISH_TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input className="ledger-search ws-name-input" aria-label="publish record name" placeholder="record name" value={wsName} onChange={(e) => setWsName(e.target.value)} />
        <button type="button" className="ledger-build" disabled={busy || ready !== true} title={ready === true ? "" : "backend not configured"} onClick={publish}>
          {busy ? "Publishing…" : "Publish"}
        </button>
        {result && <button type="button" className="ws-delete" disabled={busy} onClick={undeploy}>Undeploy</button>}
      </div>
      {ready === false && <p className="targets-skipped">{target} not configured — set its credentials in Deploy.</p>}
      {error && <p className="ledger-error">{error}</p>}
      {result && (
        <p className="ws-note">
          {undeployed ? "undeployed ✓" : `published (${result.kind})${result.agentId ? ` — agent ${result.agentId}` : ""}${result.harnessId ? ` — harness ${result.harnessId}` : ""}`}
        </p>
      )}
    </div>
  );
}

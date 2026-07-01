import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { Loading } from "../../shell/Loading.js";
import {
  deployTargetsRoute, setCredentialRoute, CREDENTIAL_KEYS, makeClient,
  bindStatusRoute, bindStartRoute, bindCompleteRoute,
} from "../../api/routes.js";

type Backend = { id: string; label: string; ready: boolean };
type BindStatus = { bound: boolean; login?: string; provider?: string } | null;
type BindFlow =
  | { step: "code"; userCode: string; verificationUri: string; deviceCode: string; interval?: number }
  | { step: "unconfigured" }
  | null;

export function Settings({ apiBase }: { apiBase: string }) {
  const [targets, setTargets] = useState<Backend[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credKey, setCredKey] = useState<(typeof CREDENTIAL_KEYS)[number]>(CREDENTIAL_KEYS[0]);
  const [credValue, setCredValue] = useState("");
  const [credNote, setCredNote] = useState<string | null>(null);

  const [bindStatus, setBindStatus] = useState<BindStatus>(null);
  const [bindFlow, setBindFlow] = useState<BindFlow>(null);
  const [bindError, setBindError] = useState<string | null>(null);

  useEffect(() => {
    deployTargetsRoute.call(makeClient(apiBase))
      .then((r) => setTargets(r.targets))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [apiBase]);

  useEffect(() => {
    bindStatusRoute.call(makeClient(apiBase))
      .then((r) => setBindStatus(r))
      .catch((e) => setBindError(e instanceof Error ? e.message : String(e)));
  }, [apiBase]);

  const connectGitHub = async () => {
    setBindError(null);
    setBindFlow(null);
    try {
      const r = await bindStartRoute.call(makeClient(apiBase));
      if (!r.configured) {
        setBindFlow({ step: "unconfigured" });
        return;
      }
      const flow: BindFlow = {
        step: "code",
        userCode: r.userCode!,
        verificationUri: r.verificationUri!,
        deviceCode: r.deviceCode!,
        interval: r.interval,
      };
      setBindFlow(flow);
      const result = await bindCompleteRoute.call(makeClient(apiBase), {
        body: { deviceCode: r.deviceCode!, interval: r.interval },
      });
      if (result.bound) {
        setBindStatus({ bound: true, login: result.login });
        setBindFlow(null);
      } else if (result.rejected) {
        setBindError(result.rejected);
        setBindFlow(null);
      }
    } catch (e) {
      setBindError(e instanceof Error ? e.message : String(e));
      setBindFlow(null);
    }
  };

  const saveCredential = async () => {
    setCredNote(null);
    setError(null);
    try {
      const { ok } = await setCredentialRoute.call(makeClient(apiBase), { body: { key: credKey, value: credValue } });
      if (ok) { setCredNote(`saved ${credKey}`); setCredValue(""); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="deploy">
      <section className="ledger-group">
        <h2 className="ledger-group-label">Credentials</h2>
        <div className="ledger-bar">
          <select className="targets-select" aria-label="credential key" value={credKey} onChange={(e) => setCredKey(e.target.value as (typeof CREDENTIAL_KEYS)[number])}>
            {CREDENTIAL_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input className="ledger-search" type="password" aria-label="credential value" placeholder="value (stored in ~/.agentgem/.env)" value={credValue} onChange={(e) => setCredValue(e.target.value)} />
          <button type="button" className="ledger-build" disabled={!credValue.trim()} onClick={saveCredential}>Save</button>
          {credNote && <span className="ws-note">{credNote}</span>}
        </div>
      </section>

      <section className="ledger-group">
        <h2 className="ledger-group-label">Verify identity</h2>
        {bindError && <p className="ledger-error">{bindError}</p>}
        {bindStatus === null ? null : bindStatus.bound ? (
          <p className="ws-note">Verified as @{bindStatus.login}</p>
        ) : (
          <>
            <p className="deploy-hint">Not verified — your installs won't count toward verified ratings</p>
            {bindFlow === null && (
              <>
                <div className="ledger-bar">
                  <button type="button" className="ledger-build" onClick={connectGitHub}>Connect GitHub</button>
                </div>
                <p className="deploy-hint">Connect to unlock 💎 Diamond — verified installs count toward your rating</p>
              </>
            )}
            {bindFlow?.step === "unconfigured" && (
              <p className="deploy-hint">Verification unavailable (not configured)</p>
            )}
            {bindFlow?.step === "code" && (
              <div>
                <p className="ws-note">Your code: <strong>{bindFlow.userCode}</strong></p>
                <p className="deploy-hint"><a href={bindFlow.verificationUri} target="_blank" rel="noreferrer">Open GitHub</a> and enter this code</p>
                <p className="deploy-hint">Waiting for verification…</p>
              </div>
            )}
          </>
        )}
      </section>

      <section className="ledger-group">
        <h2 className="ledger-group-label">Deploy backends</h2>
        {error && <p className="ledger-error">{error}</p>}
        {!targets ? <Loading />
          : targets.length === 0 ? <p className="ledger-empty">No deploy backends.</p>
          : (
            <div className="ws-list">
              {targets.map((t) => (
                <article className="ws-card" key={t.id}>
                  <header className="ws-head">
                    <span className="ws-name">{t.label}</span>
                    <span className={"deploy-badge " + (t.ready ? "is-ready" : "is-unready")}>
                      {t.ready ? "ready" : "needs credentials"}
                    </span>
                  </header>
                  <p className="tb-path">{t.id}</p>
                </article>
              ))}
            </div>
          )}
        <p className="deploy-hint">Deploy a gem from the Workspaces panel once its backend shows “ready”.</p>
      </section>
    </div>
  );
}

export const settingsPage = defineConsolePage({
  id: "settings",
  title: "Settings",
  icon: "⚙",
  order: 10,
  group: "settings",
  route: "#/settings",
  component: ({ apiBase }) => <Settings apiBase={apiBase} />,
});

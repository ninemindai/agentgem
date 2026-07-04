import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { Loading } from "../../shell/Loading.js";
import {
  deployTargetsRoute, setCredentialRoute, CREDENTIAL_KEYS, makeClient,
  bindStatusRoute, bindStartRoute, bindCompleteRoute, bindDisconnectRoute, webHandoffRoute,
} from "../../api/routes.js";

type Backend = { id: string; label: string; ready: boolean };
type BindStatus = { bound: boolean; login?: string; provider?: string; avatarUrl?: string } | null;
type BindFlow =
  | { step: "code"; userCode: string; verificationUri: string; verificationUriComplete?: string; deviceCode: string; interval?: number }
  | { step: "unconfigured" }
  | null;

// The aggregator returns machine-readable rejection slugs; turn them into guidance.
// `unknown-producer` is the common one on a fresh key — the bind requires you to
// have produced (shared/published) at least once before an identity can be linked.
function rejectionMessage(slug: string): string {
  switch (slug) {
    case "unknown-producer":
      return "Publish or share a Gem first — verification links your GitHub to an identity that has already produced something.";
    case "bad-signature":
      return "Verification failed a signature check. Please try Connect again.";
    case "stale":
      return "The verification request expired. Please try Connect again.";
    case "provider-error":
      return "Couldn't reach GitHub just now. Please try again in a moment.";
    case "not-configured":
      return "Identity verification isn't configured on this server.";
    default:
      return `Verification failed: ${slug}`;
  }
}

export function Settings({ apiBase }: { apiBase: string }) {
  const [targets, setTargets] = useState<Backend[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credKey, setCredKey] = useState<(typeof CREDENTIAL_KEYS)[number]>(CREDENTIAL_KEYS[0]);
  const [credValue, setCredValue] = useState("");
  const [credNote, setCredNote] = useState<string | null>(null);

  const [bindStatus, setBindStatus] = useState<BindStatus>(null);
  const [bindFlow, setBindFlow] = useState<BindFlow>(null);
  const [bindError, setBindError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [polling, setPolling] = useState(false);

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

  // Step 1: mint the device code and show it. No polling and no browser launch yet —
  // both happen when the user clicks "copy & open GitHub" (below), so the polled
  // code and the code they authorize always match.
  const connectGitHub = async () => {
    setBindError(null);
    setBindFlow(null);
    try {
      const r = await bindStartRoute.call(makeClient(apiBase), { body: {} });
      if (!r.configured) {
        setBindFlow({ step: "unconfigured" });
        return;
      }
      setBindFlow({
        step: "code",
        userCode: r.userCode!,
        verificationUri: r.verificationUri!,
        verificationUriComplete: r.verificationUriComplete,
        deviceCode: r.deviceCode!,
        interval: r.interval,
      });
    } catch (e) {
      setBindError(e instanceof Error ? e.message : String(e));
      setBindFlow(null);
    }
  };

  // Step 2: copy the code, open GitHub in the system browser, then poll for
  // completion until the user authorizes.
  const copyOpenAndWait = async () => {
    if (bindFlow?.step !== "code" || polling) return;
    const flow = bindFlow;
    // Prefer the code-prefilled URL — the user lands on "just click Authorize".
    const url = flow.verificationUriComplete ?? flow.verificationUri;
    void navigator.clipboard?.writeText(flow.userCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    window.open(url, "_blank", "noopener"); // desktop: main.ts routes this to the system browser
    setBindError(null);
    setPolling(true);
    try {
      const result = await bindCompleteRoute.call(makeClient(apiBase), {
        body: { deviceCode: flow.deviceCode, interval: flow.interval },
      });
      if (result.bound) {
        setBindStatus({ bound: true, login: result.login, avatarUrl: result.avatarUrl });
        setBindFlow(null);
      } else if (result.rejected) {
        setBindError(rejectionMessage(result.rejected));
        setBindFlow(null);
      }
    } catch (e) {
      setBindError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolling(false);
    }
  };

  // Open app.agentgem.ai already signed in: the local session mints a one-time handoff code
  // (server-side, bearer-authenticated), and we open the redeem URL in the system browser.
  const openOnWeb = async () => {
    setBindError(null);
    try {
      const r = await webHandoffRoute.call(makeClient(apiBase), { body: {} });
      if (r.authenticated && r.url) window.open(r.url, "_blank", "noopener");
      else setBindError("Session expired — reconnect GitHub to open on the web.");
    } catch (e) {
      setBindError(e instanceof Error ? e.message : String(e));
    }
  };

  const disconnectGitHub = async () => {
    setBindError(null);
    setBindFlow(null);
    try {
      const r = await bindDisconnectRoute.call(makeClient(apiBase), { body: {} });
      setBindStatus(r);
    } catch (e) {
      setBindError(e instanceof Error ? e.message : String(e));
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
          <div className="ledger-bar">
            <span className="ws-note">
              {bindStatus.avatarUrl && (
                <img src={bindStatus.avatarUrl} alt={`@${bindStatus.login}`} width={20} height={20}
                     style={{ borderRadius: "50%", verticalAlign: "middle", marginRight: 6 }} />
              )}
              Verified as @{bindStatus.login}
            </span>
            <button type="button" className="ledger-build" onClick={openOnWeb}>Open on the web ↗</button>
            <button type="button" className="ledger-view" onClick={disconnectGitHub}>Disconnect</button>
          </div>
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
                <button type="button" className="ledger-build" onClick={copyOpenAndWait} disabled={polling}>
                  {polling ? "Waiting for authorization…" : copied ? "✓ Copied — opening GitHub…" : "⧉ Copy code & open GitHub"}
                </button>
                <p className="deploy-hint">Copies the code and opens GitHub in your browser — enter it there and authorize; this verifies automatically. Didn't open? <a href={bindFlow.verificationUriComplete ?? bindFlow.verificationUri} target="_blank" rel="noreferrer">Open GitHub</a>.</p>
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

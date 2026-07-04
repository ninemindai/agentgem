import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { Loading } from "../../shell/Loading.js";
import {
  deployTargetsRoute, setCredentialRoute, CREDENTIAL_KEYS, makeClient,
  bindStatusRoute, bindStartRoute, bindCompleteRoute, bindDisconnectRoute,
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
    // Open the GitHub tab synchronously inside the click gesture so the popup
    // blocker allows it, then redirect it to the device page once /bind/start
    // returns the URL. (No `noopener` — we need the handle to set its location.)
    const ghTab = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    try {
      const r = await bindStartRoute.call(makeClient(apiBase), { body: {} });
      if (!r.configured) {
        ghTab?.close();
        setBindFlow({ step: "unconfigured" });
        return;
      }
      const flow: BindFlow = {
        step: "code",
        userCode: r.userCode!,
        verificationUri: r.verificationUri!,
        verificationUriComplete: r.verificationUriComplete,
        deviceCode: r.deviceCode!,
        interval: r.interval,
      };
      setBindFlow(flow);
      // Prefer the code-prefilled URL — the user lands on "just click Authorize".
      const url = r.verificationUriComplete ?? r.verificationUri!;
      if (ghTab) ghTab.location.href = url;              // browser: redirect the pre-opened tab
      else window.open(url, "_blank", "noopener");       // desktop: main.ts routes this to the system browser
      const result = await bindCompleteRoute.call(makeClient(apiBase), {
        body: { deviceCode: r.deviceCode!, interval: r.interval },
      });
      if (result.bound) {
        setBindStatus({ bound: true, login: result.login, avatarUrl: result.avatarUrl });
        setBindFlow(null);
      } else if (result.rejected) {
        setBindError(rejectionMessage(result.rejected));
        setBindFlow(null);
      }
    } catch (e) {
      ghTab?.close();
      setBindError(e instanceof Error ? e.message : String(e));
      setBindFlow(null);
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
                <p className="ws-note">
                  Your code: <strong>{bindFlow.userCode}</strong>
                  <button
                    type="button"
                    className="ledger-view"
                    style={{ marginLeft: 8 }}
                    aria-label="Copy code"
                    onClick={() => {
                      void navigator.clipboard?.writeText(bindFlow.userCode);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? "✓ Copied" : "⧉ Copy"}
                  </button>
                </p>
                <p className="deploy-hint">We opened GitHub in your browser — enter this code there. Didn't open? <a href={bindFlow.verificationUriComplete ?? bindFlow.verificationUri} target="_blank" rel="noreferrer">Open GitHub</a>.</p>
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

import { useState } from "react";
import { defineConsolePage } from "../../registry.js";
import {
  makeClient,
  webHandoffRoute,
} from "../../api/routes.js";
import { useIdentity } from "../../identity/IdentityProvider.js";
import { useGitHubBind } from "../../identity/useGitHubBind.js";
import { ConnectGitHub } from "../../identity/ConnectGitHub.js";
import { AgentTasks } from "./AgentTasks.js";
import { NotifyBell } from "../../notify/NotifyBell.js";

export function Settings({ apiBase }: { apiBase: string }) {
  const { status: bindStatus, refresh, disconnect } = useIdentity();
  const bind = useGitHubBind(apiBase);
  const [bindError, setBindError] = useState<string | null>(null);

  // Open app.agentgem.ai already signed in: the local session mints a one-time handoff
  // code (server-side, bearer-authenticated), and we open the redeem URL in the browser.
  const openOnWeb = async () => {
    setBindError(null);
    try {
      const r = await webHandoffRoute.call(makeClient(apiBase), { body: {} });
      if (r.authenticated && r.url) window.open(r.url, "_blank", "noopener");
      else { await refresh(); setBindError("Session expired — reconnect GitHub to open on the web."); }
    } catch (e) {
      setBindError(e instanceof Error ? e.message : String(e));
    }
  };

  const disconnectGitHub = async () => {
    setBindError(null);
    bind.reset();
    try {
      await disconnect();
    } catch (e) {
      setBindError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="deploy">
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
            {bindStatus.sessionActive
              ? <button type="button" className="ledger-build" onClick={openOnWeb}>Open on the web ↗</button>
              : <span className="ws-note">Session expired — Disconnect then Connect to sign in on the web</span>}
            <button type="button" className="ledger-view" onClick={disconnectGitHub}>Disconnect</button>
          </div>
        ) : (
          <>
            <p className="deploy-hint">Not verified — your installs won't count toward verified ratings</p>
            <ConnectGitHub
              bind={bind}
              idleHint={<p className="deploy-hint">Connect to unlock 💎 Diamond — verified installs count toward your rating</p>}
            />
          </>
        )}
      </section>

      <section className="ledger-group">
        <h2 className="ledger-group-label">Notifications</h2>
        <div className="ledger-bar">
          <NotifyBell />
          <span className="ws-note">Desktop notification when a background report finishes.</span>
        </div>
      </section>

      <section className="ledger-group">
        <h2 className="ledger-group-label">Background agent tasks</h2>
        <p className="deploy-hint">
          Reports, distillation, recommendations and judging run a local coding agent in the
          background. They default to a fast model — pick a different agent or model per task.
        </p>
        <AgentTasks apiBase={apiBase} />
      </section>
    </div>
  );
}

export const settingsPage = defineConsolePage({
  id: "settings",
  title: "Settings",
  icon: "⚙",
  order: 10,
  footer: true,
  route: "#/settings",
  component: ({ apiBase }) => <Settings apiBase={apiBase} />,
});

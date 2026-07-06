// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Publish a reviewed Curate selection as a Playbook to the Explore registry.
// Two-step: (1) save the selection as a named workspace via createWorkspaceRoute,
// (2) publish that workspace to the registry + mint a share card via playbookPublishRoute.
import { useEffect, useState } from "react";
import {
  createWorkspaceRoute, playbookPublishRoute, makeClient,
  bindStatusRoute, bindStartRoute, bindCompleteRoute,
} from "../../api/routes.js";
import { buildSelection } from "./selection.js";

export interface PublishToExploreProps {
  apiBase: string;
  selected: Set<string>;
  skillCount: number;
  lessonCount: number;
  defaultName?: string;
}

export function PublishToExplore({ apiBase, selected, skillCount, lessonCount, defaultName }: PublishToExploreProps) {
  const [scope, setScope] = useState("");
  const [name, setName] = useState(defaultName ?? "");
  const [version, setVersion] = useState("1.0.0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ exploreRef: string; shareUrl: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [bindStatus, setBindStatus] = useState<{ bound: boolean; login?: string } | null>(null);
  const [connecting, setConnecting] = useState<{ userCode: string; verificationUri: string; deviceCode: string; interval?: number } | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  const provenance = `distilled from ${skillCount} skill${skillCount === 1 ? "" : "s"} and ${lessonCount} lesson${lessonCount === 1 ? "" : "s"}`;

  useEffect(() => {
    const client = makeClient(apiBase);
    bindStatusRoute.call(client).then((s) => {
      setBindStatus(s);
      if (s.bound && s.login) setScope((cur) => cur || `@${s.login}`);
    }).catch(() => setBindStatus({ bound: false }));
  }, [apiBase]);

  // Step 1: mint the device code and show it. Deliberately does NOT start polling
  // yet — polling begins only when the user clicks "copy & open GitHub" (below), so
  // the code being polled and the code they authorize are always the same, and the
  // ~5-min poll window aligns with the moment they actually go to authorize.
  const connectGitHub = async () => {
    setError(null);
    setConnectBusy(true);
    try {
      const client = makeClient(apiBase);
      const start = await bindStartRoute.call(client, { body: {} });
      if (!start.configured) {
        setError("GitHub verification isn't set up on this server.");
        return;
      }
      setConnecting({ userCode: start.userCode!, verificationUri: start.verificationUri!, deviceCode: start.deviceCode!, interval: start.interval });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach GitHub — try again.");
    } finally {
      setConnectBusy(false);
    }
  };

  // Step 2: copy the code, open GitHub in the system browser, then poll for
  // completion. The long-poll resolves once the user authorizes in the browser.
  const copyOpenAndWait = async () => {
    if (!connecting || polling) return;
    void navigator.clipboard?.writeText(connecting.userCode);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 1500);
    window.open(connecting.verificationUri, "_blank", "noopener"); // desktop: main.ts routes to the system browser
    setError(null);
    setPolling(true);
    try {
      const client = makeClient(apiBase);
      const res = await bindCompleteRoute.call(client, { body: { deviceCode: connecting.deviceCode, interval: connecting.interval } });
      if (res.bound) { setBindStatus({ bound: true, login: res.login }); setConnecting(null); }
      else setError(res.rejected === "unknown-producer" ? "Share telemetry once first, then connect." : `Couldn't verify with GitHub (${res.rejected}).`);
    } catch (err) {
      // Any thrown error (network, expired/denied device code) must surface, not vanish.
      setError(err instanceof Error ? err.message : "Couldn't reach GitHub — try again.");
    } finally {
      setPolling(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimName = name.trim();
    const trimScope = scope.trim();
    if (!trimName || !trimScope) return;
    setBusy(true);
    setError(null);
    try {
      const client = makeClient(apiBase);
      // Step 1: save the reviewed selection as a named workspace
      await createWorkspaceRoute.call(client, { body: { name: trimName, selection: buildSelection(selected) } });
      // Step 2: publish workspace to registry + mint share card
      const pub = await playbookPublishRoute.call(client, {
        body: { workspace: trimName, scope: trimScope, name: trimName, version: version.trim() || "1.0.0", provenance },
      });
      setResult({ exploreRef: pub.exploreRef, shareUrl: pub.shareUrl });
    } catch (err) {
      // ClientError exposes .body with the raw response body — prefer it as
      // the error message since it's more specific than the generic status line.
      const body = (err as Record<string, unknown>).body;
      const bodyStr = typeof body === "string" ? body : body != null ? JSON.stringify(body) : null;
      setError(bodyStr ?? (err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = () => {
    if (!result?.shareUrl) return;
    navigator.clipboard.writeText(result.shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (result) {
    return (
      <div className="publish-result">
        <p>Published: <code>{result.exploreRef}</code></p>
        {result.shareUrl && (
          <p>
            Share: <a href={result.shareUrl}>{result.shareUrl}</a>
            {" "}
            <button type="button" className="ledger-sort" onClick={copyUrl}>{copied ? "Copied!" : "Copy"}</button>
          </p>
        )}
      </div>
    );
  }

  return (
    <form className="publish-form" onSubmit={handleSubmit}>
      <div className="publish-head">
        <h3>Publish to Explore</h3>
        {bindStatus?.bound && (
          <span className="publish-verified">✓ Verified as @{bindStatus.login}</span>
        )}
      </div>
      <p className="publish-note">Publish this Playbook to the public Explore catalog for anyone to install.</p>

      {bindStatus && !bindStatus.bound && (
        <div className="explore-connect">
          {!connecting ? (
            <>
              <button type="button" className="ledger-sort" onClick={connectGitHub} disabled={connectBusy}>
                {connectBusy ? "Generating code…" : "Connect GitHub"}
              </button>
              <p>Optional — verify authorship so your Playbook publishes as verified.</p>
            </>
          ) : (
            <>
              <p>Your code: <strong>{connecting.userCode}</strong></p>
              <button type="button" className="ledger-build" onClick={copyOpenAndWait} disabled={polling}>
                {polling ? "Waiting for authorization…" : codeCopied ? "✓ Copied — opening GitHub…" : "⧉ Copy code & open GitHub"}
              </button>
              <p className="deploy-hint">
                Copies the code and opens GitHub in your browser — enter it there and authorize; this window verifies automatically.
                {" "}Didn't open? <a href={connecting.verificationUri} target="_blank" rel="noreferrer">Open GitHub</a>.
              </p>
            </>
          )}
        </div>
      )}

      <div className="publish-fields">
        <label className="publish-field">
          <span className="publish-label">scope</span>
          <input id="publish-scope" className="ledger-search publish-scope" placeholder="e.g. @me"
            value={scope} onChange={(e) => setScope(e.target.value)} required />
        </label>
        <label className="publish-field">
          <span className="publish-label">name</span>
          <input id="publish-name" className="ledger-search" placeholder="playbook name"
            value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="publish-field">
          <span className="publish-label">version</span>
          <input id="publish-version" className="ledger-search publish-version" placeholder="1.0.0"
            value={version} onChange={(e) => setVersion(e.target.value)} />
        </label>
      </div>

      <div className="publish-foot">
        <span className="publish-provenance">{provenance}</span>
        <button
          type="submit"
          className="ledger-build"
          disabled={busy || !name.trim() || !scope.trim()}
        >
          {busy ? "Publishing…" : "Publish"}
        </button>
      </div>
      {error && <p className="publish-error">{error}</p>}
    </form>
  );
}

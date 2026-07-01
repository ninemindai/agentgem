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
}

export function PublishToExplore({ apiBase, selected, skillCount, lessonCount }: PublishToExploreProps) {
  const [scope, setScope] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ exploreRef: string; shareUrl: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [bindStatus, setBindStatus] = useState<{ bound: boolean; login?: string } | null>(null);
  const [connecting, setConnecting] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);

  const provenance = `distilled from ${skillCount} skill${skillCount === 1 ? "" : "s"} and ${lessonCount} lesson${lessonCount === 1 ? "" : "s"}`;

  useEffect(() => {
    const client = makeClient(apiBase);
    bindStatusRoute.call(client).then(setBindStatus).catch(() => setBindStatus({ bound: false }));
  }, [apiBase]);

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
      setConnecting({ userCode: start.userCode!, verificationUri: start.verificationUri! });
      const res = await bindCompleteRoute.call(client, { body: { deviceCode: start.deviceCode!, interval: start.interval } });
      if (res.bound) setBindStatus({ bound: true, login: res.login });
      else setError(res.rejected === "unknown-producer" ? "Share telemetry once first, then connect." : `Couldn't verify with GitHub (${res.rejected}).`);
    } catch (err) {
      // Any thrown error (network, expired/denied device code) must surface, not vanish.
      setError(err instanceof Error ? err.message : "Couldn't reach GitHub — try again.");
    } finally {
      setConnecting(null);
      setConnectBusy(false);
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
        <h3>Share to Explore</h3>
        {bindStatus?.bound && (
          <span className="publish-verified">✓ Verified as @{bindStatus.login}</span>
        )}
      </div>
      <p className="publish-note">Publish this Playbook to the public Explore catalog for anyone to install.</p>

      {bindStatus && !bindStatus.bound && (
        <div className="explore-connect">
          <button type="button" className="ledger-sort" onClick={connectGitHub} disabled={connectBusy}>
            {connectBusy ? "Connecting…" : "Connect GitHub"}
          </button>
          <p>
            Optional — verify authorship so your Playbook publishes as verified.
            {connecting && (
              <> Open <a href={connecting.verificationUri} target="_blank" rel="noreferrer">{connecting.verificationUri}</a> and enter <code>{connecting.userCode}</code>.</>
            )}
          </p>
        </div>
      )}

      <div className="publish-fields">
        <input
          id="publish-scope"
          aria-label="scope"
          className="ledger-search publish-scope"
          placeholder="scope (e.g. @me)"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          required
        />
        <input
          id="publish-name"
          aria-label="name"
          className="ledger-search"
          placeholder="playbook name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          id="publish-version"
          aria-label="version"
          className="ledger-search publish-version"
          placeholder="version"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
        />
      </div>

      <div className="publish-foot">
        <span className="publish-provenance">{provenance}</span>
        <button
          type="submit"
          className="ledger-build"
          disabled={busy || !name.trim() || !scope.trim()}
        >
          {busy ? "Sharing…" : "Share to Explore"}
        </button>
      </div>
      {error && <p className="publish-error">{error}</p>}
    </form>
  );
}

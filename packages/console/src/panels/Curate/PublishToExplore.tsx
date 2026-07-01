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

  const provenance = `distilled from ${skillCount} skill${skillCount === 1 ? "" : "s"} and ${lessonCount} lesson${lessonCount === 1 ? "" : "s"}`;

  useEffect(() => {
    const client = makeClient(apiBase);
    bindStatusRoute.call(client).then(setBindStatus).catch(() => setBindStatus({ bound: false }));
  }, [apiBase]);

  const connectGitHub = async () => {
    const client = makeClient(apiBase);
    const start = await bindStartRoute.call(client);
    if (!start.configured) {
      setError("Set AGENTGEM_GITHUB_CLIENT_ID to connect GitHub");
      return;
    }
    setConnecting({ userCode: start.userCode!, verificationUri: start.verificationUri! });
    const res = await bindCompleteRoute.call(client, { body: { deviceCode: start.deviceCode!, interval: start.interval } });
    setConnecting(null);
    if (res.bound) setBindStatus({ bound: true, login: res.login });
    else setError(res.rejected === "unknown-producer" ? "Share telemetry once first, then connect." : `Connect failed: ${res.rejected}`);
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
            <button type="button" onClick={copyUrl}>{copied ? "Copied!" : "Copy"}</button>
          </p>
        )}
      </div>
    );
  }

  return (
    <form className="publish-form" onSubmit={handleSubmit}>
      <h3>Share to Explore</h3>
      <p className="publish-note">Scope is caller-supplied — account-binding coming.</p>
      {bindStatus && !bindStatus.bound && (
        <div className="explore-connect">
          <button type="button" onClick={connectGitHub}>Connect GitHub</button>
          {connecting && (
            <p>
              Open <a href={connecting.verificationUri} target="_blank" rel="noreferrer">{connecting.verificationUri}</a> and enter <code>{connecting.userCode}</code>
            </p>
          )}
        </div>
      )}
      <label>
        <span className="visually-hidden">scope</span>
        <input
          id="publish-scope"
          aria-label="scope"
          className="ledger-search"
          placeholder="scope (e.g. @me)"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          required
        />
      </label>
      <label>
        <span className="visually-hidden">name</span>
        <input
          id="publish-name"
          aria-label="name"
          className="ledger-search"
          placeholder="playbook name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <label>
        <span className="visually-hidden">version</span>
        <input
          id="publish-version"
          aria-label="version"
          className="ledger-search"
          placeholder="version"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
        />
      </label>
      <p className="publish-provenance">{provenance}</p>
      <button
        type="submit"
        className="ledger-build"
        disabled={busy || !name.trim() || !scope.trim() || !bindStatus?.bound}
      >
        {busy ? "Sharing…" : "Share to explore"}
      </button>
      {error && <p className="publish-error">{error}</p>}
    </form>
  );
}

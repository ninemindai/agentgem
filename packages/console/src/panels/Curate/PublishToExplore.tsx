// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Publish a reviewed Curate selection as a Playbook to the Explore registry.
// Two-step: (1) save the selection as a named workspace via createWorkspaceRoute,
// (2) publish that workspace to the registry + mint a share card via playbookPublishRoute.
import { useEffect, useState } from "react";
import { createWorkspaceRoute, publishSetupRoute, makeClient } from "../../api/routes.js";
import { useIdentity } from "../../identity/IdentityProvider.js";
import { useGitHubBind } from "../../identity/useGitHubBind.js";
import { ConnectGitHub } from "../../identity/ConnectGitHub.js";
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
  const { status: bindStatus } = useIdentity();
  const bind = useGitHubBind(apiBase);

  const provenance = `distilled from ${skillCount} skill${skillCount === 1 ? "" : "s"} and ${lessonCount} lesson${lessonCount === 1 ? "" : "s"}`;

  // Prefill the scope from the verified login, without clobbering a typed value.
  useEffect(() => {
    if (bindStatus?.bound && bindStatus.login) setScope((cur) => cur || `@${bindStatus.login}`);
  }, [bindStatus?.bound, bindStatus?.login]);

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
      const pub = await publishSetupRoute.call(client, {
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
          <ConnectGitHub
            bind={bind}
            idleHint={<p>Optional — verify authorship so your Playbook publishes as verified.</p>}
          />
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

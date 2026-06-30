import { useEffect, useState } from "react";
import {
  makeClient, registryReadyRoute, workspacesRoute, registryPublishRoute,
} from "../../api/routes.js";
import { defineConsolePage } from "../../registry.js";

type Result = { ref: string; version: string; path: string };

export function RegistryPublish({ apiBase }: { apiBase: string }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [workspaces, setWorkspaces] = useState<{ name: string }[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [scope, setScope] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let alive = true;
    registryReadyRoute.call(makeClient(apiBase)).then((r) => { if (alive) setReady(r.ready); }).catch(() => { if (alive) setReady(false); });
    workspacesRoute.call(makeClient(apiBase)).then((r) => { if (alive) setWorkspaces(r.workspaces); }).catch(() => {});
    return () => { alive = false; };
  }, [apiBase]);

  const publish = () => {
    setBusy(true);
    setError(null);
    setResult(null);
    registryPublishRoute.call(makeClient(apiBase), {
      body: {
        workspace: workspace.trim(),
        scope: scope.trim(),
        name: name.trim() || undefined,
        version: version.trim(),
        tags: tags.trim() ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
        description: description.trim() || undefined,
      },
    })
      .then((r) => setResult(r))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (ready === null) return <p className="ws-note">Loading…</p>;
  if (!ready) return <p className="ws-note">Registry not configured — set AGENTGEM_REGISTRY_REPO + GITHUB_TOKEN on the server.</p>;

  return (
    <div className="publish-registry">
      <label>
        Workspace{" "}
        <select aria-label="workspace" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
          <option value="">Select a workspace…</option>
          {workspaces.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
        </select>
      </label>
      <label>
        Scope{" "}
        <input aria-label="scope" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="your-github-login-or-org" />
      </label>
      <label>
        Name{" "}
        <input aria-label="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="(optional — defaults from the gem)" />
      </label>
      <label>
        Version{" "}
        <input aria-label="version" value={version} onChange={(e) => setVersion(e.target.value)} />
      </label>
      <label>
        Tags{" "}
        <input aria-label="tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma,separated" />
      </label>
      <label>
        Description{" "}
        <input aria-label="description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <button type="button" onClick={publish} disabled={busy || !workspace || !scope || !version}>
        {busy ? "Publishing…" : "Publish"}
      </button>
      {error && <p className="ledger-error">{error}</p>}
      {result && <p className="ws-note">Published {result.ref}@{result.version} → {result.path} ✓</p>}
    </div>
  );
}

export const publishPage = defineConsolePage({
  id: "publish",
  title: "Publish",
  icon: "⇧",
  order: 25,
  group: "library",
  route: "#/publish",
  component: ({ apiBase }) => <RegistryPublish apiBase={apiBase} />,
});

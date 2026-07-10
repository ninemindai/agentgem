import { useState } from "react";
import { makeAuth, type Me } from "../auth";
import type { makeApi } from "../api";
import { makeUpload, NotSignedIn } from "../upload";
import { HandleClaim } from "../HandleClaim";

type Result = { ok: true; ref: string } | { ok: false; msg: string };

export function Publish({ api: _api, me, base }: { api: ReturnType<typeof makeApi>; me: Me | null; base: string }) {
  const [scope, setScope] = useState(me?.handle ?? "");
  const [version, setVersion] = useState("1.0.0");
  const [tags, setTags] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  if (!me) {
    const signIn = (provider: "github" | "google") => {
      setResult(null);
      makeAuth(base).signIn(provider, window.location.href).catch((err) => setResult({ ok: false, msg: err instanceof Error ? err.message : String(err) }));
    };
    return (
      <div className="ex-card">
        <p>Sign in to publish your gems. <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("github"); }}>Sign in with GitHub</a> <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("google"); }}>Sign in with Google</a></p>
        {result && !result.ok && <p className="ex-error">{result.msg}</p>}
      </div>
    );
  }

  if (!me.handle) {
    // Lazy claim: a signed-in user with no handle (a fresh Google account) cannot publish until they
    // pick a public name. Refetch the session on success so `me.handle` (and the scope default) fill in.
    return (
      <div className="ex-card">
        <HandleClaim base={base} onClaimed={() => { window.location.reload(); }} />
      </div>
    );
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await makeUpload(base).publish({
        file, scope, version,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      setResult({ ok: true, ref: r.ref });
    } catch (err) {
      setResult({ ok: false, msg: err instanceof NotSignedIn ? "You must be signed in to publish." : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ex-card">
      <h2>Publish a gem</h2>
      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Scope
          <input aria-label="scope" type="text" value={scope} onChange={(e) => setScope(e.target.value)} required className="ex-search" style={{ margin: 0 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Version
          <input aria-label="version" type="text" value={version} onChange={(e) => setVersion(e.target.value)} required className="ex-search" style={{ margin: 0 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Tags (comma-separated)
          <input aria-label="tags" type="text" value={tags} onChange={(e) => setTags(e.target.value)} className="ex-search" style={{ margin: 0 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          .gem file
          <input aria-label=".gem file" type="file" accept=".gem" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </label>
        <button type="submit" disabled={busy} className="ex-signin" style={{ alignSelf: "flex-start" }}>
          {busy ? "Publishing…" : "Publish"}
        </button>
      </form>
      {result?.ok && (
        <p className="ex-empty" style={{ color: "var(--verified)", borderColor: "var(--verified-wash)" }}>
          Published as <a href={"/gems/" + encodeURIComponent(result.ref)}>{result.ref}</a>
        </p>
      )}
      {result && !result.ok && <p className="ex-error">{result.msg}</p>}
    </div>
  );
}

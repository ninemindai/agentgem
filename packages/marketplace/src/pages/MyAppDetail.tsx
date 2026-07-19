// Owner-only detail page for a single "My apps" gem (any visibility, including private) — the
// counterpart to Gem.tsx (public Explore detail) for gems that are deliberately absent from Explore.
// Reachable only from /my-apps; ownership is never asserted client-side — getMyGem itself is
// session-scoped, so a non-owner gets the same 404 as an unknown key.
import { useEffect, useState } from "react";
import type { makeApi, MyGemDetail } from "../api";
import { defaultApiBase } from "../api";
import { makeAuth, type Me } from "../auth";
import { GamePlayer } from "../GamePlayer";
import { GemContents } from "./GemContents";
import { gemDate } from "../gems/catalog";
import { navigate } from "../nav";

type View = { status: "loading" } | { status: "not-found" } | { status: "error"; message: string } | { status: "ok"; gem: MyGemDetail };

const VISIBILITY_LABEL: Record<MyGemDetail["visibility"], string> = { public: "Public", unlisted: "Unlisted", private: "Private" };

function VisibilityBadge({ visibility }: { visibility: MyGemDetail["visibility"] }) {
  return <span className={`ex-tag ex-visibility-badge ex-visibility-badge--${visibility}`}>{VISIBILITY_LABEL[visibility]}</span>;
}

export function MyAppDetail({ api, me, keyName }: { api: ReturnType<typeof makeApi>; me: Me | null; keyName: string }) {
  const [view, setView] = useState<View>({ status: "loading" });
  const [downloadErr, setDownloadErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  // The currently-open inline player, if any: html once resolved (null while loading) — mirrors
  // MyApps' playPrivate.
  const [playing, setPlaying] = useState<{ html: string | null } | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    api.getMyGem(keyName)
      .then((gem) => { if (alive) setView({ status: "ok", gem }); })
      .catch((e) => {
        if (!alive) return;
        const s = String((e as Error)?.message ?? e);
        setView(/-> 404/.test(s) ? { status: "not-found" } : { status: "error", message: s });
      });
    return () => { alive = false; };
    // api is a stable module-level singleton (App.tsx) — excluded so re-renders don't refetch.
  }, [me, keyName]);

  if (!me) {
    const auth = makeAuth(defaultApiBase());
    const signIn = (provider: "github" | "google" | "twitter") => auth.signIn(provider, window.location.href);
    return (
      <div className="ex-card">
        <p>Sign in to see this app. <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("github"); }}>Sign in with GitHub</a> <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("google"); }}>Sign in with Google</a> <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("twitter"); }}>Sign in with X</a></p>
      </div>
    );
  }

  if (view.status === "loading") return <div className="ex-gem-detail"><p className="ex-empty">Loading…</p></div>;
  if (view.status === "not-found") return <div className="ex-gem-detail"><p className="ex-empty">"{keyName}" not found or not yours.</p></div>;
  if (view.status === "error") return <div className="ex-gem-detail"><p className="ex-error">Couldn&apos;t load "{keyName}": {view.message}</p></div>;

  const { gem } = view;
  const isGame = gem.artifactKinds.includes("game");

  // Download the .gem file so it can be imported into the local app (Get Gems → Import a .gem
  // file). Owner-gated archive fetch — mirrors Gem.tsx's downloadGem, swapping in getOwnerGemArchive.
  const downloadGem = async () => {
    setDownloadErr(null);
    try {
      const b64 = await api.getOwnerGemArchive(gem.key, gem.version);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/gzip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${gem.key.replace(/^@/, "").replace(/[^a-zA-Z0-9_.-]+/g, "-")}-${gem.version}.gem`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { setDownloadErr("Download failed — please try again."); }
  };

  const playPrivate = async () => {
    setPlayError(null);
    setPlaying({ html: null });
    try {
      const meta = await api.getOwnerGameMeta(gem.key);
      const html = await api.getOwnerGameHtml(gem.key, meta.version);
      setPlaying({ html });
    } catch (e) {
      setPlaying(null);
      setPlayError(String((e as Error)?.message ?? e));
    }
  };

  // Owner-only unpublish. Display-gating only — the server re-checks ownership.
  const unpublish = async () => {
    if (!window.confirm(`Unpublish "${gem.key}"? This permanently removes it from app.agentgem.ai for everyone. This can't be undone.`)) return;
    setRemoving(true); setRemoveErr(null);
    try {
      await api.unpublishGem(gem.key, gem.version);
      navigate("/my-apps");
    } catch (e) {
      const s = String(e);
      setRemoveErr(/-> 401/.test(s) ? "Please sign in again to unpublish." : /-> 403/.test(s) ? "You can only unpublish your own gems." : "Unpublish failed — please try again.");
      setRemoving(false);
    }
  };

  return (
    <div className="ex-gem-detail">
      <h2 className="ex-gem-title">{gem.key} <span className="ex-gem-version">v{gem.version}</span> <VisibilityBadge visibility={gem.visibility} /></h2>
      {gem.description && <p className="ex-gem-desc">{gem.description}</p>}
      {gem.createdAtMs && (
        <p className="ex-gem-dates">
          <span>Created <time dateTime={new Date(gem.createdAtMs).toISOString()}>{gemDate(gem.createdAtMs)}</time></span>
          {gem.updatedAtMs && gem.updatedAtMs !== gem.createdAtMs && (
            <span> · Updated <time dateTime={new Date(gem.updatedAtMs).toISOString()}>{gemDate(gem.updatedAtMs)}</time></span>
          )}
        </p>
      )}

      {isGame && (
        <section className="ex-card ex-game-play">
          <h3>Play</h3>
          {!playing && <button type="button" className="ex-signin" onClick={playPrivate}>Play</button>}
          {playError && <p className="ex-error" role="alert">Couldn&apos;t load that game: {playError}</p>}
          {playing && (
            <div className="ex-my-apps-player">
              <div className="ex-my-apps-player__head">
                <button type="button" className="ex-signin" onClick={() => setPlaying(null)}>Close</button>
              </div>
              {playing.html ? <GamePlayer html={playing.html} interactive /> : <p className="ex-empty">Loading…</p>}
            </div>
          )}
        </section>
      )}

      <GemContents artifacts={(gem.artifacts ?? []) as { name: string; type: string }[]} />

      <section className="ex-card">
        <h3>Get this gem</h3>
        <div className="ex-install-alt">
          <button type="button" className="ex-download-gem" onClick={downloadGem}>Download .gem</button>
          <span className="ex-install-alt-hint"> and import it in AgentGem → <strong>Get Gems</strong> → <strong>Import a .gem file</strong>.</span>
        </div>
        {downloadErr && <div className="ex-danger-err">{downloadErr}</div>}
      </section>

      <section className="ex-card ex-danger">
        <h3>Owner controls</h3>
        <p className="ex-danger-note">Unpublishing removes this gem from app.agentgem.ai for everyone. This can't be undone.</p>
        {removeErr && <p className="ex-danger-err">{removeErr}</p>}
        <button type="button" className="ex-unpublish" disabled={removing} onClick={unpublish}>
          {removing ? "Unpublishing…" : "Unpublish this gem"}
        </button>
      </section>
    </div>
  );
}

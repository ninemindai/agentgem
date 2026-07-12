// packages/marketplace/src/pages/MyApps.tsx
// /my-apps: the owner's own gems across every visibility (public/unlisted/private) — the only place
// a private gem is reachable from, since it is deliberately absent from Explore (/gems) and the
// public Minigames arcade. A game gem gets a Play button; for a private one that resolves through
// the owner-only session-gated routes (getOwnerGameMeta/getOwnerGameHtml) rather than the public
// aggregator ones, which 404 anything not public. Ownership itself is never asserted client-side —
// the server derives it from the session cookie, `me` here is display-only.
import { useEffect, useState } from "react";
import type { makeApi, MyGem } from "../api";
import { defaultApiBase } from "../api";
import { makeAuth, type Me } from "../auth";
import { GamePlayer } from "../GamePlayer";
import { gamePath } from "../entityPath";

type View = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; gems: MyGem[] };

const VISIBILITY_LABEL: Record<MyGem["visibility"], string> = { public: "Public", unlisted: "Unlisted", private: "Private" };

function VisibilityBadge({ visibility }: { visibility: MyGem["visibility"] }) {
  return <span className={`ex-tag ex-visibility-badge ex-visibility-badge--${visibility}`}>{VISIBILITY_LABEL[visibility]}</span>;
}

export function MyApps({ api, me }: { api: ReturnType<typeof makeApi>; me: Me | null }) {
  const [view, setView] = useState<View>({ status: "loading" });
  // The currently-open inline player, if any: which gem, and its html once resolved (null while loading).
  const [playing, setPlaying] = useState<{ key: string; html: string | null } | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    api.getMyGems()
      .then((r) => { if (alive) setView({ status: "ok", gems: r.gems }); })
      .catch((e) => { if (alive) setView({ status: "error", message: String((e as Error)?.message ?? e) }); });
    return () => { alive = false; };
    // api is a stable module-level singleton (App.tsx) — excluded so re-renders don't refetch.
  }, [me]);

  if (!me) {
    const auth = makeAuth(defaultApiBase());
    const signIn = (provider: "github" | "google") => auth.signIn(provider, window.location.href);
    return (
      <div className="ex-card">
        <p>Sign in to see the apps you&apos;ve published, including anything private. <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("github"); }}>Sign in with GitHub</a> <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("google"); }}>Sign in with Google</a></p>
      </div>
    );
  }

  const playPrivate = async (key: string) => {
    setPlayError(null);
    setPlaying({ key, html: null });
    try {
      const meta = await api.getOwnerGameMeta(key);
      const html = await api.getOwnerGameHtml(key, meta.version);
      setPlaying({ key, html });
    } catch (e) {
      setPlaying(null);
      setPlayError(String((e as Error)?.message ?? e));
    }
  };

  return (
    <div className="ex-card">
      <h2>My apps</h2>
      {view.status === "loading" && <p className="ex-empty">Loading…</p>}
      {view.status === "error" && <p className="ex-error">Couldn&apos;t load your apps: {view.message}</p>}
      {view.status === "ok" && view.gems.length === 0 && <p className="ex-empty">Nothing published yet. Publish a gem from Studio to see it here.</p>}
      {view.status === "ok" && view.gems.length > 0 && (
        <ul className="ex-my-apps-list">
          {view.gems.map((g) => {
            const isGame = g.artifactKinds.includes("game");
            return (
              <li key={g.key + "@" + g.version} className="ex-my-apps-item">
                <div className="ex-my-apps-item__head">
                  <span className="ex-my-apps-item__key">{g.key}</span>
                  <VisibilityBadge visibility={g.visibility} />
                </div>
                {g.description && <p className="ex-my-apps-item__desc">{g.description}</p>}
                <div className="ex-my-apps-item__actions">
                  {/* Details always goes to the owner detail (/my-apps/<key>), which resolves every
                      visibility via getMyGem — unlike /gems/<key> (Explore), which only ever resolves
                      PUBLIC gems (listCatalogGems filters visibility = 'public'). */}
                  <a className="ex-navlink" href={"/my-apps/" + encodeURIComponent(g.key)}>Details</a>
                  {isGame && g.visibility === "private" && (
                    <button type="button" className="ex-signin" onClick={() => playPrivate(g.key)}>Play</button>
                  )}
                  {isGame && g.visibility !== "private" && (
                    <a className="ex-signin" href={gamePath(g.key)}>Play</a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {playError && <p className="ex-error" role="alert">Couldn&apos;t load that game: {playError}</p>}
      {playing && (
        <div className="ex-my-apps-player">
          <div className="ex-my-apps-player__head">
            <span>{playing.key}</span>
            <button type="button" className="ex-signin" onClick={() => setPlaying(null)}>Close</button>
          </div>
          {playing.html ? <GamePlayer html={playing.html} interactive /> : <p className="ex-empty">Loading…</p>}
        </div>
      )}
    </div>
  );
}

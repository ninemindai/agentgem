// packages/marketplace/src/pages/Play.tsx
// /games/<key> — the shareable game link. A stranger opens this and the game is already running:
// no account, no install. The URL is the whole point, so this page is reachable by address alone
// (the /minigames grid navigates here rather than portalling a URL-less overlay).
//
// The key may be a published @scope/name or a scope-less unlisted share id; both resolve through
// game-meta -> (title, version) -> game-html. Sealing is GamePlayer's job, not ours.
import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import { GamePlayer } from "../GamePlayer";
import { navigate } from "../nav";

type Api = ReturnType<typeof makeApi>;

export function Play({ api, gemKey }: { api: Api; gemKey: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    setHtml(null); setTitle(null); setMissing(false);
    (async () => {
      // Two hops on purpose: the URL carries no version, and game-html demands one.
      const meta = await api.getGameMeta(gemKey);
      if (!alive) return;
      setTitle(meta.title);
      const h = await api.getGameHtml(gemKey, meta.version);
      if (alive) setHtml(h);
    })().catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [api, gemKey]);

  if (missing) {
    return (
      <div className="mg">
        <h2 className="mg-h">This game link doesn't exist</h2>
        <p className="mg-intro">It may have been unpublished or revoked. <a href="/minigames">Browse mini-games →</a></p>
      </div>
    );
  }

  if (!html) return <p className="mg-intro">Loading {title ?? gemKey}…</p>;

  return <GamePlayer html={html} interactive startFullscreen onExitFullscreen={() => navigate("/minigames")} />;
}

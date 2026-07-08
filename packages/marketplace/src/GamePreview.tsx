// packages/marketplace/src/GamePreview.tsx
// A clickable game preview: the animated (non-interactive) thumbnail with a ▶ badge; click launches the
// sealed game into fullscreen play. Shared by the /minigames arcade cards and the gem-detail page so both
// surfaces play a game the same way. Fills its positioned container (set the height/border on the wrapper).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { makeApi } from "./api";
import { GamePlayer } from "./GamePlayer";

type Api = ReturnType<typeof makeApi>;

export function GamePreview({ api, gemKey, version }: { api: Api; gemKey: string; version: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getGameHtml(gemKey, version).then((h) => { if (alive) setHtml(h); }).catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [api, gemKey, version]);

  return (
    <>
      <button type="button" className="gp-thumb" disabled={!html} onClick={() => setPlaying(true)}
        title={html ? "Play" : undefined} aria-label={`Play ${gemKey}`}>
        {html
          ? <GamePlayer html={html} interactive={false} />
          : <span className="gp-ph">{err ? "preview unavailable" : "loading…"}</span>}
        {html && <span className="gp-play-badge" aria-hidden>▶</span>}
      </button>
      {playing && html && createPortal(
        // Portal to <body>: the fullscreen overlay is position:fixed, which anchors to the nearest
        // TRANSFORMED ancestor — and .mg-card:hover applies a transform, which would trap the overlay
        // inside the card. Rendering at the body root escapes any transformed/overflow ancestor so it
        // truly covers the viewport.
        <GamePlayer html={html} interactive startFullscreen onExitFullscreen={() => setPlaying(false)} />,
        document.body,
      )}
    </>
  );
}

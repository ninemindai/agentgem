// packages/marketplace/src/GamePreview.tsx
// A clickable game preview: the animated (non-interactive) thumbnail with a ▶ badge; click launches the
// sealed game into fullscreen play. Shared by the /minigames arcade cards and the gem-detail page so both
// surfaces play a game the same way. Fills its positioned container (set the height/border on the wrapper).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { makeApi } from "./api";
import { GamePlayer } from "./GamePlayer";
import { visitorId } from "./visitor";

type Api = ReturnType<typeof makeApi>;

// onPlayCountChange reports a delta, mirroring StarButton's optimistic → revert: +1 the instant the
// reader clicks, then -1 if the beacon never reached the server. The arcade card owns the number; the
// gem-detail page passes nothing and just plays.
export function GamePreview({ api, gemKey, version, onPlayCountChange }: {
  api: Api; gemKey: string; version: string; onPlayCountChange?: (delta: number) => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [playing, setPlaying] = useState(false);
  const thumbRef = useRef<HTMLButtonElement>(null);
  // A thumbnail is a whole game: the iframe parses its html and RUNS it. Booting one per card meant a
  // full grid launched a dozen applications on first paint. Wait until the card is near the viewport.
  // No IntersectionObserver (jsdom, old browsers) → fetch eagerly, exactly as before.
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (near || !thumbRef.current) return;
    // A small rootMargin only: the grid is ~2 viewports tall on a laptop, so a screen-sized margin
    // would mark every card "near" and defer nothing. 200px still boots a card before it is scrolled to.
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(thumbRef.current);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let alive = true;
    api.getGameHtml(gemKey, version).then((h) => { if (alive) setHtml(h); }).catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [api, gemKey, version, near]);

  return (
    <>
      {/* The click — not the html fetch above — is what counts as a play: the grid mounts a thumbnail
          for every card, so fetching html means "the card rendered", never "someone played". */}
      <button ref={thumbRef} type="button" className="gp-thumb" disabled={!html}
        onClick={() => {
          setPlaying(true);
          onPlayCountChange?.(1); // optimistic — the reader sees their own play land immediately
          void api.recordPlay(gemKey, version, visitorId()).then((ok) => { if (!ok) onPlayCountChange?.(-1); });
        }}
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

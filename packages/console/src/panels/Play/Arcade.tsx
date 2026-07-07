// packages/console/src/panels/Play/Arcade.tsx
import { useEffect, useState } from "react";
import { makeClient, playMiniappsRoute, playMiniappRoute } from "../../api/routes.js";
import { Runner } from "./Runner.js";
import { genre as genreOf, CHIP } from "./playMeta.js";

type Item = { name: string; title: string; genre: string; needs?: string[] };

// A live but click-through preview of the game, lazily fetched per card.
function Thumb({ apiBase, name }: { apiBase: string; name: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    playMiniappRoute.call(makeClient(apiBase), { query: { name } }).then((r) => { if (alive) setHtml(r.html); }).catch(() => {});
    return () => { alive = false; };
  }, [apiBase, name]);
  return (
    <div className="play-card__thumb">
      {html && <Runner html={html} interactive={false} />}
      <div className="play-thumb-scrim" />
      <div className="play-card__play"><span>▶</span></div>
    </div>
  );
}

export function Arcade({ apiBase, onOpen }: { apiBase: string; onOpen: (name: string) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => {
    playMiniappsRoute.call(makeClient(apiBase)).then((r) => setItems(r.miniapps)).catch(() => setItems([]));
  }, [apiBase]);

  if (!items) return <p className="play-intro">Loading miniapps…</p>;
  if (items.length === 0) return (
    <div className="play-empty">
      <b>No miniapps yet</b>
      Create one from a session, skill, or project — or import an existing HTML game.
    </div>
  );
  return (
    <ul className="play-grid">
      {items.map((m) => {
        const g = genreOf(m.genre);
        return (
          <li key={m.name} className="play-card" onClick={() => onOpen(m.name)} title={`Open ${m.title}`}>
            <Thumb apiBase={apiBase} name={m.name} />
            <div className="play-card__body">
              <div className="play-card__title">{m.title}</div>
              <div className="play-card__row">
                <span className="play-pill"><span className="play-pill__dot" style={{ background: g.tint }} />{g.icon} {g.label}</span>
                {m.needs && m.needs.length
                  ? m.needs.map((n) => <span key={n} className="play-pill" title={CHIP[n]?.title}>{CHIP[n]?.label ?? n}</span>)
                  : <span className="play-pill play-pill--offline">🟢 offline</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

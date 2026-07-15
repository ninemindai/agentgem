// packages/console/src/panels/Play/Arcade.tsx
import { useEffect, useState } from "react";
import { makeClient, playMiniappsRoute, playMiniappRoute, playDeleteRoute } from "../../api/routes.js";
import { Runner } from "./Runner.js";
import { genre as genreOf, CHIP } from "./playMeta.js";

type Item = { name: string; title: string; genre: string; needs?: string[] };

// Mirrors the server's slugify (packages/play/src/studio.ts) closely enough to answer one cosmetic
// question: could the reader have guessed this id from the title? Drift is harmless — the worst case is
// an id subtitle that didn't need to be there, never a wrong one.
const slugify = (raw: string): string =>
  raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 40) || "miniapp";

// Show a card's id only when the title can't identify it. Two cases: the id isn't derivable from the
// title (a `-2` suffix, or a name the user typed), or a sibling card shares the title. Printing it
// always would be noise — seedStudio sets meta.title to the id, so most seeded cards would say it twice.
function idIsWorthShowing(m: Item, all: Item[]): boolean {
  return slugify(m.title) !== m.name || all.some((o) => o.name !== m.name && o.title === m.title);
}

// A live but click-through preview of the game, lazily fetched per card. Broker-fed games (needs) get
// their host data postMessaged in by the Runner, so the thumbnail is a real replay, not a waiting state.
function Thumb({ apiBase, name, needs }: { apiBase: string; name: string; needs?: string[] }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    playMiniappRoute.call(makeClient(apiBase), { query: { name } }).then((r) => { if (alive) setHtml(r.html); }).catch(() => {});
    return () => { alive = false; };
  }, [apiBase, name]);
  return (
    <div className="play-card__thumb">
      {html && <Runner html={html} interactive={false} name={name} apiBase={apiBase} needs={needs} />}
      <div className="play-thumb-scrim" />
      <div className="play-card__play"><span>▶</span></div>
    </div>
  );
}

// The card's own delete affordance. The wrapper stops propagation, so clicks that bubble up from Cancel /
// Delete never reach the <li>, which is the "open" target — otherwise confirming would also launch the
// miniapp behind the overlay. Titles are NOT unique (creating twice from one source yields two miniapps
// with the same title), so the id is shown alongside — it is the only thing telling two cards apart.
function DeleteOverlay({ name, title, busy, error, onCancel, onConfirm }: {
  name: string; title: string; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="play-card__confirm" onClick={(e) => e.stopPropagation()}>
      <div className="play-card__confirm-msg">Delete “{title}”?</div>
      <div className="play-card__confirm-id">{name}</div>
      {error
        ? <div className="play-card__confirm-err">{error}</div>
        : <div className="play-card__confirm-note">Restorable from the registry’s git history.</div>}
      <div className="play-card__confirm-actions">
        <button type="button" className="play-btn" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="play-btn play-btn--danger" disabled={busy} onClick={onConfirm}>
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );
}

export function Arcade({ apiBase, onOpen }: { apiBase: string; onOpen: (name: string) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Both are keyed to the miniapp they belong to, not to the grid: a plain boolean/string would let an
  // in-flight delete on one card render "Deleting…" (or its error) inside a different card's dialog.
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<{ name: string; message: string } | null>(null);
  useEffect(() => {
    playMiniappsRoute.call(makeClient(apiBase)).then((r) => setItems(r.miniapps)).catch(() => setItems([]));
  }, [apiBase]);

  const askDelete = (name: string) => { setConfirming(name); setError(null); };
  const cancelDelete = () => { setConfirming(null); setError(null); };

  const doDelete = async (name: string) => {
    setDeleting(name); setError(null);
    try {
      await playDeleteRoute.call(makeClient(apiBase), { body: { name } });
      setItems((prev) => (prev ?? []).filter((m) => m.name !== name));
      setConfirming((c) => (c === name ? null : c));   // never dismiss a dialog this delete didn't open
    } catch (e) {
      setError({ name, message: (e as Error).message }); // keep the card + confirm up: visible and retryable
    } finally { setDeleting(null); }
  };

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
        const asking = confirming === m.name;
        const showId = idIsWorthShowing(m, items);
        return (
          <li key={m.name} className="play-card" onClick={() => !asking && onOpen(m.name)} title={`Open ${m.name}`}>
            {/* Built-ins (__-prefixed, e.g. __ember) are served constants, not registry entries — deleting
                them is meaningless (and would 404), so they carry no delete affordance. */}
            {!m.name.startsWith("__") && (
              <button
                type="button" className="play-card__del" aria-label={`Delete ${m.name}`} title={`Delete ${m.name}`}
                disabled={deleting !== null}   // no second dialog while a delete is in flight
                onClick={(e) => { e.stopPropagation(); askDelete(m.name); }}
              >✕</button>
            )}
            <Thumb apiBase={apiBase} name={m.name} needs={m.needs} />
            <div className="play-card__body">
              <div className="play-card__title">{m.title}</div>
              {showId && <div className="play-card__id">{m.name}</div>}
              <div className="play-card__row">
                <span className="play-pill"><span className="play-pill__dot" style={{ background: g.tint }} />{g.icon} {g.label}</span>
                {m.needs && m.needs.length
                  ? m.needs.map((n) => <span key={n} className="play-pill" title={CHIP[n]?.title}>{CHIP[n]?.label ?? n}</span>)
                  : <span className="play-pill play-pill--offline">🟢 offline</span>}
              </div>
            </div>
            {asking && (
              <DeleteOverlay
                name={m.name} title={m.title}
                busy={deleting === m.name}
                error={error?.name === m.name ? error.message : null}
                onCancel={cancelDelete} onConfirm={() => void doDelete(m.name)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

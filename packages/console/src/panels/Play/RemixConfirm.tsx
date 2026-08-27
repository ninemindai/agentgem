// packages/console/src/panels/Play/RemixConfirm.tsx
// The remix deep-link consent card. NOTHING is fetched or written on arrival — the arrival only
// renders this card; the fetch + fork happen on the explicit click (spec I3's mirror: pulling a
// published artifact IN is an authored act too). deeplink.ts's "play installs nothing" stays true.
import { useState } from "react";
import { makeClient, playRemixSourceRoute, playImportRoute, GAME_GENRE_VALUES } from "../../api/routes.js";

type Genre = (typeof GAME_GENRE_VALUES)[number];
const asGenre = (g: string): Genre | undefined => (GAME_GENRE_VALUES as readonly string[]).includes(g) ? (g as Genre) : undefined;

export function RemixConfirm({ apiBase, gemKey, onCreated, onCancel }: {
  apiBase: string;
  gemKey: string;
  onCreated: (name: string, seedPrompt?: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function doRemix() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const src = await playRemixSourceRoute.call(makeClient(apiBase), { query: { key: gemKey } });
      const short = gemKey.split("/").pop() ?? gemKey;
      const genre = asGenre(src.genre);
      const res = await playImportRoute.call(makeClient(apiBase), { body: {
        title: `${short}-remix`, html: src.html,
        remixOf: { gemKey, version: src.version },
        ...(genre ? { genre } : {}),
      } });
      onCreated(res.name, `This is a remix of "${gemKey}" — make it your own.`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <div className="play-banner">
      <span className="play-banner__ico">🍴</span>
      <div className="play-banner__body">
        <div className="play-banner__title">Remix “{gemKey}”?</div>
        <div className="play-banner__detail">{error || "This copies the published game into your arcade so you can make it your own. Nothing is fetched until you confirm."}</div>
      </div>
      <button className="play-btn play-btn--primary" disabled={busy} onClick={() => void doRemix()}>{busy ? "Fetching…" : "Remix"}</button>
      <button className="play-btn play-btn--ghost" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  );
}

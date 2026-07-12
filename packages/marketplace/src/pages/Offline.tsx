import { useEffect, useState } from "react";
import { defaultApiBase, type makeApi } from "../api";
import { GamePreview } from "../GamePreview";
import { listPinned, unpinGame, storageEstimate, type PinnedGame } from "../offline";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The "Offline library": every game the reader downloaded for offline play. Each card plays IN PLACE
// here — GamePreview fetches the game html, which the service worker serves from the never-evicted
// games-pinned cache, so it plays with no network at all. This page is deliberately the offline play
// surface: the home grid (catalog list) and the gem detail page (gem metadata) both need uncached API
// calls and go blank / "not found" offline, whereas this page needs only the localStorage pin index.
export function Offline({ api }: { api: ReturnType<typeof makeApi> }) {
  const [pins, setPins] = useState<PinnedGame[]>(() => listPinned());
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => { void storageEstimate().then(setEst); }, [pins]);

  const remove = async (p: PinnedGame) => {
    await unpinGame(defaultApiBase(), p.key, p.version);
    setPins((prev) => prev.filter((x) => !(x.key === p.key && x.version === p.version)));
  };

  return (
    <div className="ex-offline-page">
      <h2 className="ex-section-title">Offline library</h2>
      {est && <p className="ex-gem-meta">Using {fmtBytes(est.usage)} of your browser's storage.</p>}
      {pins.length === 0 ? (
        <p className="ex-empty">No games downloaded yet. Open any game and choose “Download for offline”.</p>
      ) : (
        <div className="ex-offline-grid">
          {pins.map((p) => (
            <div key={`${p.key}@${p.version}`} className="ex-offline-card">
              <div className="ex-offline-thumb"><GamePreview api={api} gemKey={p.key} version={p.version} /></div>
              <div className="ex-offline-meta">
                <span className="ex-offline-title">{p.title}</span>
                <span className="ex-gem-version">v{p.version}</span>
                <span className="ex-offline-size">{fmtBytes(p.size)}</span>
                <button type="button" className="ex-linkbtn" onClick={() => remove(p)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

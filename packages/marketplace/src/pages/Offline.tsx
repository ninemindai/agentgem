import { useEffect, useState } from "react";
import { defaultApiBase } from "../api";
import { listPinned, unpinGame, storageEstimate, type PinnedGame } from "../offline";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The "Offline library": every game the reader downloaded for offline play, with sizes and a remove
// control, plus total storage used. Pins live in Cache Storage (served by the SW); this page reads the
// localStorage index that mirrors them.
export function Offline() {
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
        <ul className="ex-offline-list">
          {pins.map((p) => (
            <li key={`${p.key}@${p.version}`} className="ex-offline-row">
              <a href={`/gems/${encodeURIComponent(p.key)}`}>{p.title}</a>
              <span className="ex-gem-version">v{p.version}</span>
              <span className="ex-offline-size">{fmtBytes(p.size)}</span>
              <button type="button" className="ex-linkbtn" onClick={() => remove(p)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { defaultApiBase } from "./api";
import { IconOffline } from "./icons";
import { pinGame, unpinGame, isPinned } from "./offline";

// "Download for offline" control (gem-detail page + arcade cards). Pins the game's html into the SW's
// never-evicted cache so it plays with no connection; toggles back to remove. Errors surface inline
// (a failed download must not look like success). `label` overrides the download-prompt text (the
// cards use "Download for offline play"); the pinned/remove wording is shared.
export function OfflineToggle({ gemKey, version, title, label = "Download for offline" }: { gemKey: string; version: string; title: string; label?: string }) {
  const [pinned, setPinned] = useState(() => isPinned(gemKey, version));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Props change on client-side navigation between game pages without a remount (Gem has no key
  // prop), so resync the badge — mirrors StarButton's sync effect.
  useEffect(() => { setPinned(isPinned(gemKey, version)); }, [gemKey, version]);

  const download = async () => {
    setBusy(true); setErr(null);
    try { await pinGame(defaultApiBase(), gemKey, version, title); setPinned(true); }
    catch { setErr("Download failed"); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setErr(null);
    try { await unpinGame(defaultApiBase(), gemKey, version); setPinned(false); }
    catch { setErr("Remove failed"); }
    finally { setBusy(false); }
  };

  return (
    <span className="ex-offline-toggle">
      {pinned ? (
        <>
          <span className="ex-offline-badge">✓ Available offline</span>
          <button type="button" className="ex-linkbtn" disabled={busy} onClick={remove}>Remove</button>
        </>
      ) : (
        <button type="button" className="ex-navlink" disabled={busy} onClick={download}>
          <IconOffline />{busy ? "Downloading…" : label}
        </button>
      )}
      {err && <span className="ex-error" role="alert">{err}</span>}
    </span>
  );
}

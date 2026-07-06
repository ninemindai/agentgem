import { useState } from "react";
import { createGemShareRoute, makeClient } from "../../api/routes.js";
import { ShareLinks } from "../Mine/ShareLinks.js";

type CreateGemShare = (body: { kind: "gem"; name: string; provenance: string; generatedAtMs: number }) => Promise<{ id: string; url: string }>;

// The light "Share link" path: mints a hosted gem card (createGemShareRoute) and
// reveals ShareLinks inline. Lifts Mine/Scorecard's mint state machine (busy/slow/
// error) so every surface inherits cold-start handling. `disabled` guards empty
// payloads (D3); `onUpgrade`, when set, renders the Publish nudge after success (D4).
export function QuickShareButton({
  apiBase, name, provenance, title,
  label = "Share link",
  disabled = false, disabledReason,
  onUpgrade, createGemShare,
}: {
  apiBase: string;
  name: string;
  provenance: string;
  title?: string;
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
  onUpgrade?: () => void;
  createGemShare?: CreateGemShare;
}) {
  const doCreate: CreateGemShare = createGemShare ?? ((body) => createGemShareRoute.call(makeClient(apiBase), { body }));
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Mirrors Scorecard.tsx: show a spinner, and past ~3s a "waking the server" hint
  // for the hosted cold start, instead of a silent wait.
  const onShare = async () => {
    setBusy(true); setErr(null); setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), 3000);
    try {
      const res = await doCreate({ kind: "gem", name, provenance, generatedAtMs: Date.now() });
      setUrl(res.url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create a share link — try again.");
    } finally { clearTimeout(slowTimer); setBusy(false); setSlow(false); }
  };

  return (
    <span className="quick-share">
      <button
        type="button"
        className="mine-wf-share"
        aria-disabled={disabled || undefined}
        disabled={busy}
        onClick={disabled ? undefined : onShare}
      >
        {busy ? "Creating link…" : label}
      </button>
      {disabled && disabledReason && <span className="quick-share-hint">{disabledReason}</span>}
      {busy && slow && <p className="scorecard-pending">Waking the server — the first share after a while can take up to ~30s.</p>}
      {err && <span className="obs-error">{err}</span>}
      {(busy || url) && (
        <div className="quick-share-result">
          <ShareLinks url={url ?? undefined} title={title ?? name} />
          {url && onUpgrade && (
            <button type="button" className="quick-share-upgrade" onClick={onUpgrade}>
              Want others to install this? Publish to Explore →
            </button>
          )}
        </div>
      )}
    </span>
  );
}

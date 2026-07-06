import { useState } from "react";
import { createGemShareRoute, makeClient } from "../../api/routes.js";
import { ShareLinks } from "../Mine/ShareLinks.js";
import { useShareMint } from "./useShareMint.js";

type GemBody = { kind: "gem"; name: string; provenance: string; generatedAtMs: number };
type CreateGemShare = (body: GemBody) => Promise<{ id: string; url: string }>;

// The light "Share link" path: mints a hosted gem card (createGemShareRoute) and
// reveals ShareLinks inline. Shares Mine/Scorecard's mint state machine via
// useShareMint, so every surface gets the same cold-start handling.
//
// `resolve`, when provided, produces the name+provenance at click time — used by
// "Share my setup" so Inspect scans inventory only when the user actually shares,
// and always with fresh data. It may throw a user-facing message (e.g. an empty
// setup), which surfaces as the inline error instead of minting a hollow card.
// When absent, the static `name`/`provenance` props are used (e.g. a lesson).
//
// `onUpgrade`, when set, renders the "Publish to Explore" nudge after a success.
export function QuickShareButton({
  apiBase, name, provenance, title, onUpgrade, createGemShare, resolve,
}: {
  apiBase: string;
  name: string;
  provenance: string;
  title?: string;
  onUpgrade?: () => void;
  createGemShare?: CreateGemShare;
  resolve?: () => Promise<{ name: string; provenance: string }>;
}) {
  const doCreate: CreateGemShare = createGemShare ?? ((body) => createGemShareRoute.call(makeClient(apiBase), { body }));
  const [url, setUrl] = useState<string | null>(null);
  const { busy, slow, err, run } = useShareMint();

  const onShare = () => run(async () => {
    const payload = resolve ? await resolve() : { name, provenance };
    const res = await doCreate({ kind: "gem", ...payload, generatedAtMs: Date.now() });
    setUrl(res.url);
  });

  return (
    <span className="quick-share">
      <button type="button" className="mine-wf-share" disabled={busy} onClick={onShare}>
        {busy ? "Creating link…" : "Share link"}
      </button>
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

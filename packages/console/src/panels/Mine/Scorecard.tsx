import { useState } from "react";
import type { Scorecard } from "../../api/routes.js";
import { createShareRoute, makeClient } from "../../api/routes.js";
import { renderCardSvg } from "./card.js";
import { ShareLinks } from "./ShareLinks.js";

// Asset-framed hero. Count stats are now plain text (filter chips moved to MineWorkflows).
// The share button mints a hosted certificate URL and shows per-platform share intents.
export type WorkflowFilter = "all" | "battleTested" | "portable";

type CreateShare = (b: { kind: "certificate"; counts: { breadth: number; battleTested: number; portable: number }; generatedAtMs: number }) => Promise<{ id: string; url: string }>;

export function ScorecardHero({ data, apiBase = "", createShare }: { data: Scorecard; apiBase?: string; createShare?: CreateShare }) {
  const counts = { breadth: data.breadth, battleTested: data.battleTested, portable: data.portable };
  const doCreate: CreateShare = createShare ?? ((body) => createShareRoute.call(makeClient(apiBase), { body }));
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const svg = renderCardSvg(counts);
  const svgDataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

  // Mint the hosted certificate URL and reveal the share options inline. The card itself is already
  // rendered client-side; the only wait here is the network create (which can be a cold start on the
  // hosted backend), so we show a spinner and, past ~3s, a "waking the server" hint instead of a
  // silent "Sharing…". No native share sheet — desktop app; inline links are the path.
  const onShare = async () => {
    setBusy(true); setErr(null); setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), 3000);
    try {
      const { url } = await doCreate({ kind: "certificate", counts, generatedAtMs: data.generatedAtMs });
      setShareUrl(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create a share link — try again.");
    } finally { clearTimeout(slowTimer); setBusy(false); setSlow(false); }
  };

  const downloadPng = () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = 1200; c.height = 630;
      c.getContext("2d")!.drawImage(img, 0, 0);
      c.toBlob((b) => {
        if (!b) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b); a.download = "agentgem-goldmine.png"; a.click();
        URL.revokeObjectURL(a.href);
      }, "image/png");
    };
    img.src = svgDataUri;
  };

  return (
    <section className="scorecard-hero" aria-label="Goldmine scorecard">
      <h2>Your log holds <strong>{data.breadth} reusable workflows</strong></h2>
      <p className="scorecard-stats">{data.battleTested} battle-tested · {data.portable} worth sharing</p>
      {data.gaps.length > 0 && <p className="scorecard-gaps">Next: {data.gaps.join(" · ")}</p>}
      <img className="scorecard-card" src={svgDataUri} alt="Goldmine certificate" width={480} />
      <div className="scorecard-actions">
        <button className="scorecard-share" onClick={onShare} disabled={busy}>
          {busy ? <><span className="scorecard-spin" aria-hidden="true" />Creating link…</> : "Share your goldmine"}
        </button>
        <button className="scorecard-download" onClick={downloadPng}>Download PNG</button>
      </div>
      {busy && slow && <p className="scorecard-pending">Waking the server — the first share after a while can take up to ~30s.</p>}
      {err && <p className="scorecard-error">{err}</p>}
      {shareUrl && <ShareLinks url={shareUrl} />}
      {data.degraded && <span className="scorecard-degraded" title="Some projects could not be fully scanned">partial</span>}
    </section>
  );
}

// Live scanning progress shown between the initial skeleton and the finished hero.
export function ScorecardScanning({ progress }: { progress: { done: number; total: number; label: string; partial: { breadth: number; battleTested: number; portable: number } } | null }) {
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <section className="scorecard-hero scorecard-scanning" aria-busy="true" aria-label="Scoring your goldmine">
      <h2>Scoring your goldmine…{progress ? ` ${progress.done}/${progress.total}` : ""}{progress?.label ? ` · ${progress.label}` : ""}</h2>
      <div className="scorecard-bar"><div className="scorecard-bar-fill" style={{ width: `${pct}%` }} /></div>
      <ul className="scorecard-counts scorecard-counts-live">
        <li>{progress?.partial.breadth ?? 0} reusable workflows</li>
        <li>{progress?.partial.battleTested ?? 0} battle-tested</li>
        <li>{progress?.partial.portable ?? 0} worth sharing</li>
      </ul>
    </section>
  );
}

// Shimmer placeholder shown while the scorecard is computed (the scan over recent
// projects takes a while). Mirrors the hero's shape so the swap-in is calm.
export function ScorecardHeroSkeleton() {
  return (
    <section className="scorecard-hero scorecard-skel" aria-label="Scoring your goldmine" aria-busy="true">
      <div className="scorecard-skel-line scorecard-skel-title" />
      <div className="scorecard-skel-row">
        <div className="scorecard-skel-pill" />
        <div className="scorecard-skel-pill" />
      </div>
      <p className="scorecard-skel-note">Scoring your goldmine…</p>
    </section>
  );
}

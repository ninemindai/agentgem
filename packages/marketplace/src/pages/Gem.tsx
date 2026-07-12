import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { Gem as GemT } from "../gems/catalog";
import { loadGems, findGem } from "../gems/catalog";
import { prettifyId, kindLabel } from "../data";
import { StarButton } from "../StarButton";
import { CutBadge } from "../CutBadge";
import { StoneRating } from "../StoneRating";
import { GemContents } from "./GemContents";
import { GamePreview } from "../GamePreview";
import { OfflineToggle } from "../OfflineToggle";
import type { StarsCtx } from "../Router";
import type { StarState } from "../stars";
import type { Me } from "../auth";
import { navigate } from "../nav";

// The locally-running console (CLI default http://127.0.0.1:4317, see src/cli.ts). A deep link into
// its Get Gems tab, pre-searched, so publishing a gem key here lands the reader ready to install.
// Best-effort: it only reaches a console on this port (the packaged app uses a random port — that's
// what the agentgem:// protocol handler is for), so the manual steps below stay as the fallback.
const LOCAL_CONSOLE = "http://localhost:4317";
// Deep-link query into the console's Get Gems tab. An installable (hosted) gem gets `?install=<key>
// &v=<version>` → the console runs a direct zero-config install (consent-gated); a browse-only gem
// falls back to `?q=<key>` (registry search), since there's no hosted archive to install.
function deepLinkQuery(gem: { key: string; version: string; installable?: boolean }): string {
  return gem.installable
    ? `install=${encodeURIComponent(gem.key)}&v=${encodeURIComponent(gem.version)}`
    : `q=${encodeURIComponent(gem.key)}`;
}
function openInConsoleUrl(gem: { key: string; version: string; installable?: boolean }): string {
  return `${LOCAL_CONSOLE}/#/get-gems?${deepLinkQuery(gem)}`;
}

// The packaged desktop app registers the agentgem:// scheme (see desktop/), so this deep-links into
// its Get Gems tab regardless of the app's (random) port. No-op until a desktop build with the
// handler is installed — the localhost link + manual steps cover the CLI/interim case.
function openInAppUrl(gem: { key: string; version: string; installable?: boolean }): string {
  return `agentgem://get-gems?${deepLinkQuery(gem)}`;
}

export function Gem({ api, keyName, stars, me }: { api: ReturnType<typeof makeApi>; keyName: string; stars: StarsCtx; me: Me | null }) {
  const [gems, setGems] = useState<GemT[] | null>(null);
  const [starState, setStarState] = useState<StarState>({ counts: {}, mine: [] });
  const [adoptions, setAdoptions] = useState<Record<string, { installs: number; verifiedInstalls: number }>>({});
  const [removing, setRemoving] = useState(false);
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const [cmdCopied, setCmdCopied] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadGems(api).then((g) => { if (alive) setGems(g); });
    return () => { alive = false; };
  }, [api]);

  useEffect(() => {
    if (!keyName) return;
    let alive = true;
    stars.api.get("gem", [keyName]).then((s) => { if (alive) setStarState(s); });
    api.gemAdoption([keyName]).then((a) => { if (alive) setAdoptions(a); });
    return () => { alive = false; };
  }, [keyName, stars.api]);

  if (gems === null) return <div className="ex-gem-detail"><p className="ex-empty">Loading…</p></div>;
  const gem = findGem(gems, keyName);
  if (!gem) return <div className="ex-gem-detail"><p className="ex-empty">Gem not found: "{keyName}".</p></div>;

  const copyKey = () => { void navigator.clipboard?.writeText(gem.key); };
  // One-liner install — works anywhere Node is installed, no app/protocol/port needed. Only offered
  // for installable gems (an uploaded archive `agentgem get` can download).
  const installCmd = `npx @ninemind/agentgem get ${gem.key}@${gem.version}`;
  const copyCmd = () => { void navigator.clipboard?.writeText(installCmd); setCmdCopied(true); window.setTimeout(() => setCmdCopied(false), 1500); };
  // Download the .gem file so it can be imported into the local app (Get Gems → Import a .gem file).
  const downloadGem = async () => {
    setDownloadErr(null);
    try {
      const b64 = await api.getGemArchiveBase64(gem.key, gem.version);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/gzip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${gem.key.replace(/^@/, "").replace(/[^a-zA-Z0-9_.-]+/g, "-")}-${gem.version}.gem`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { setDownloadErr("Download failed — please try again."); }
  };

  // Owner-only unpublish. Display-gating only — the server re-checks ownership (login === publishedBy).
  const { key: gemKey, version: gemVersion, publishedBy } = gem;
  const isGame = gem.artifactKinds.includes("game");
  const isOwner = !!(me && me.handle && publishedBy && me.handle.toLowerCase() === publishedBy.toLowerCase());
  const label = isGame ? "mini-game" : "gem";
  const unpublish = async () => {
    if (!window.confirm(`Unpublish "${gemKey}"? This permanently removes it from app.agentgem.ai for everyone. This can't be undone.`)) return;
    setRemoving(true); setRemoveErr(null);
    try {
      await api.unpublishGem(gemKey, gemVersion);
      navigate(isGame ? "/miniapps" : "/gems");
    } catch (e) {
      const s = String(e);
      setRemoveErr(/-> 401/.test(s) ? "Please sign in again to unpublish." : /-> 403/.test(s) ? "You can only unpublish your own gems." : "Unpublish failed — please try again.");
      setRemoving(false);
    }
  };

  return (
    <div className="ex-gem-detail">
      <h2 className="ex-gem-title">{gem.key} <span className="ex-gem-version">v{gem.version}</span> <CutBadge cut={gem.cut} /> <StoneRating cut={gem.cut} grade={gem.grade} stars={starState.counts[gem.key] ?? 0} installs={adoptions[gem.key]?.installs ?? 0} verifiedInstalls={adoptions[gem.key]?.verifiedInstalls ?? 0} />
        <StarButton kind="gem" id={gem.key} count={starState.counts[gem.key] ?? 0} starred={starState.mine.includes(gem.key)}
          signedIn={stars.signedIn} loginUrl={stars.loginUrl} api={stars.api} />
      </h2>
      <p className="ex-gem-meta">
        {gem.publishedBy
          ? <a className="ex-gem-author" href={"/@" + encodeURIComponent(gem.publishedBy)}>@{gem.publishedBy}</a>
          : (gem.author ? <span>by {gem.author}</span> : null)}
        {gem.artifactKinds.map((k) => <span key={k} className="ex-chip">{kindLabel(k)}</span>)}
      </p>
      <p className="ex-gem-desc">{gem.description}</p>
      <p className="ex-gem-tags">{gem.tags.map((t) => <span key={t} className="ex-tag">#{t}</span>)}</p>

      {gem.artifactKinds.includes("game") && (
        <section className="ex-card ex-game-play">
          <h3>Play</h3>
          <div className="ex-game-stage"><GamePreview api={api} gemKey={gem.key} version={gem.version} /></div>
          <p className="ex-game-hint">Sealed and runs entirely in your browser — click to play fullscreen.</p>
          <OfflineToggle gemKey={gem.key} version={gem.version} title={gem.key} />
        </section>
      )}

      <GemContents artifacts={gem.artifacts ?? []} />

      <section className="ex-card">
        <h3>Get this gem</h3>
        {gem.installable && (
          <div className="ex-install-cmd">
            <div className="ex-install-cmd-label">Install from your terminal — works anywhere Node is installed:</div>
            <div className="ex-install-cmd-row">
              <code className="ex-install-cmd-text">{installCmd}</code>
              <button type="button" className="ex-copy" onClick={copyCmd}>{cmdCopied ? "Copied ✓" : "Copy"}</button>
            </div>
            <div className="ex-install-alt">
              or <button type="button" className="ex-download-gem" onClick={downloadGem}>Download .gem</button>
              <span className="ex-install-alt-hint"> and import it in AgentGem → <strong>Get Gems</strong> → <strong>Import a .gem file</strong>.</span>
            </div>
            {downloadErr && <div className="ex-danger-err">{downloadErr}</div>}
          </div>
        )}
        <p className="ex-getit">
          <a className="ex-open-app" href={openInAppUrl(gem)}>Open in AgentGem →</a>
          Gem key: <code className="ex-key">{gem.key}</code>
          <button type="button" className="ex-copy" onClick={copyKey}>Copy key</button>
        </p>
        <p className="ex-getit-steps">Opens the AgentGem desktop app straight to <strong>Get Gems</strong>{gem.installable ? " and installs it" : ", pre-searched"}. Running the CLI console? <a className="ex-getit-link" href={openInConsoleUrl(gem)} target="_blank" rel="noreferrer">Open on localhost:4317</a>. Not running? Start AgentGem → <strong>Get Gems</strong> → search "{gem.key}" → <strong>Install</strong>.</p>
      </section>

      {isOwner && (
        <section className="ex-card ex-danger">
          <h3>Owner controls</h3>
          <p className="ex-danger-note">Unpublishing removes this {label} from app.agentgem.ai for everyone. This can't be undone.</p>
          {removeErr && <p className="ex-danger-err">{removeErr}</p>}
          <button type="button" className="ex-unpublish" disabled={removing} onClick={unpublish}>
            {removing ? "Unpublishing…" : `Unpublish this ${label}`}
          </button>
        </section>
      )}

      {gem.ingredients.length > 0 && (
        <section className="ex-card">
          <h3>Contains</h3>
          <ul className="ex-ingredients">
            {gem.ingredients.map((ing) => {
              const p = prettifyId(ing.id, ing.kind);
              return (
                <li key={ing.id}>
                  <a href={"/ingredients/" + encodeURIComponent(ing.id)} title={ing.id}>{p.name}</a>
                  <span className="ex-chip">{kindLabel(ing.kind)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

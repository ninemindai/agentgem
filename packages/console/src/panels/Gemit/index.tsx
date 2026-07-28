// packages/console/src/panels/Gemit/index.tsx
// The Gemit screen: score the local 30-day window, read the card, publish it, share it —
// without leaving the app.
//
// Why this screen exists rather than a button in the generated HTML: publishing signs the
// manifest with the local producer keypair (~/.agentgem/identity.json), which a file://
// document can never read. The signing has to happen server-side, so the affordance
// belongs where a server is already running.
//
// The report is framed sandbox="allow-scripts" (no allow-same-origin), so links inside it
// could not navigate even if they were there — which is why the server renders it sealed
// and the share buttons live out here in React instead.
import { useCallback, useEffect, useState } from "react";
import { defineConsolePage } from "../../contract.js";
import { gemitPublishRoute, gemitReportRoute, gemitWindowRoute, makeClient } from "../../api/routes.js";

type Report = Awaited<ReturnType<typeof gemitReportRoute.call>>;
type Publish = Awaited<ReturnType<typeof gemitPublishRoute.call>>;

// Structural, not a policy promise: transcripts are read on this machine to compute the
// three scores and are never part of GemitData, so there is no code path — flag or
// otherwise — by which their contents could reach the network.
const TRANSCRIPT_DISCLAIMER =
  "Your session transcripts are read locally and never leave this machine — not during scoring, not when publishing. Only the numbers on the card are ever uploaded, and only if you choose to publish.";

const REJECTION: Record<string, string> = {
  "not-bound": "Connect an account first — use the identity chip in the footer.",
  insufficient: "No score yet: 5 substantial sessions in the last 30 days are needed.",
  conflict: "That card key already belongs to another account.",
};

export function GemitPage({ apiBase }: { apiBase: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [scanning, setScanning] = useState(true);
  const [failed, setFailed] = useState(false);
  const [window_, setWindow] = useState<Awaited<ReturnType<typeof gemitWindowRoute.call>> | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [includeUsage, setIncludeUsage] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<Publish | null>(null);

  const scan = useCallback(() => {
    setScanning(true); setFailed(false); setWindow(null); setElapsed(0);
    // Two calls on purpose: /window enumerates only and lands well before /report, so the
    // ~30s scan can report "scoring 150 of 5,870" rather than spinning blind. It is
    // sub-second warm but ~11s cold, which is why the copy below has a pre-count state
    // rather than assuming the number is there immediately. A failure is not fatal — it
    // costs the label, nothing else, so the scan still proceeds.
    gemitWindowRoute.call(makeClient(apiBase)).then(setWindow).catch(() => {});
    gemitReportRoute.call(makeClient(apiBase))
      .then(setReport)
      .catch(() => setFailed(true))
      .finally(() => setScanning(false));
  }, [apiBase]);

  useEffect(scan, [scan]);

  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [scanning]);

  const publish = () => {
    setPublishing(true);
    gemitPublishRoute.call(makeClient(apiBase), { body: { includeUsage } })
      .then(setResult)
      .catch(() => setResult({ published: false, reason: "unreachable", shareUrl: null, x: null, linkedin: null, facebook: null }))
      .finally(() => setPublishing(false));
  };

  if (scanning) {
    const pct = window_ && window_.willScore
      // No per-session callback exists to drive a real bar, so this is an ELAPSED-TIME
      // estimate against a ~14 sessions/sec observed rate, capped at 95% so it never
      // claims to be finished. The session COUNTS beside it are exact.
      ? Math.min(95, Math.round((elapsed * 14 * 100) / window_.willScore))
      : 0;
    return (
      <section className="analyze">
        <p className="gemit-status">
          {window_
            ? <>Scoring <strong>{window_.willScore.toLocaleString()}</strong> of{" "}
                <strong>{window_.qualifyingSessions.toLocaleString()}</strong> qualifying sessions
                from the last 30 days… <span className="gemit-elapsed">{elapsed}s</span></>
            : <>Finding your sessions from the last 30 days…</>}
        </p>
        <div className="gemit-progress"><i style={{ width: `${pct}%` }} /></div>
        <p className="gemit-note">{TRANSCRIPT_DISCLAIMER}</p>
      </section>
    );
  }
  if (failed || !report) {
    return (
      <section className="analyze">
        <p className="gemit-status">Couldn’t score your sessions.{" "}
          <button type="button" className="gemit-btn" onClick={scan}>Try again</button></p>
      </section>
    );
  }

  const canPublish = !report.insufficient && report.bound;

  return (
    <section className="analyze">
      <div className="gemit-bar">
        <div className="gemit-bar__who">
          {report.insufficient
            ? <strong>No score yet</strong>
            : <><strong>{report.tier} — {report.composite}/100</strong>
                <span className="gemit-bar__sub">
                  {report.windowFrom} → {report.windowTo} · {report.scoredSessions} of{" "}
                  {report.qualifyingSessions} sessions · {report.projects} projects
                </span></>}
        </div>
        <div className="gemit-bar__act">
          <button type="button" className="gemit-btn" onClick={scan}>Rescan</button>
          {!result?.published && (
            <button type="button" className="gemit-btn gemit-btn--go" disabled={!canPublish || publishing} onClick={publish}>
              {publishing ? "Publishing…" : "Publish card"}
            </button>
          )}
        </div>
      </div>

      {!report.insufficient && !result?.published && (
        <div className="gemit-consent">
          <label>
            {/* autoComplete=off: Chrome restores checkbox state across reloads and fires a
                change event, which would silently re-arm this widening from a previous
                visit. A consent control must start from its documented default. */}
            <input type="checkbox" autoComplete="off" checked={includeUsage}
              onChange={(e) => setIncludeUsage(e.target.checked)} />
            Also share my coding agents and most-used skill/subagent names
          </label>
          {/* Mirrors the CLI's consent line, and moves with the checkbox for the same
              reason: a disclosure that stays put while the payload widens is a false one. */}
          <p className="gemit-consent__what">
            {includeUsage
              ? "Ships: scores, counts, window dates, your coding agents, and your most-used skill/subagent names. Never: projects, transcripts."
              : "Ships: scores, counts, window dates. Never: coding agents, skill/subagent names, projects, transcripts."}
          </p>
          <p className="gemit-note">{TRANSCRIPT_DISCLAIMER}</p>
          {!report.bound && <p className="gemit-consent__what">{REJECTION["not-bound"]}</p>}
        </div>
      )}

      {result && !result.published && (
        <p className="gemit-status">Not published — {REJECTION[result.reason ?? ""] ?? result.reason}</p>
      )}

      {result?.published && result.shareUrl && (
        <div className="gemit-published">
          <div>
            <strong>Published</strong>{" "}
            <a href={result.shareUrl} target="_blank" rel="noopener noreferrer">{result.shareUrl}</a>
          </div>
          <div className="gemit-share">
            <a className="gemit-btn" href={result.x!} target="_blank" rel="noopener noreferrer">Share on X</a>
            <a className="gemit-btn" href={result.linkedin!} target="_blank" rel="noopener noreferrer">LinkedIn</a>
            <a className="gemit-btn" href={result.facebook!} target="_blank" rel="noopener noreferrer">Facebook</a>
          </div>
        </div>
      )}

      {/* allow-scripts WITHOUT allow-same-origin — the sheet carries inline interactive JS
          and stays sealed off from the console. Same treatment as the rubric report. */}
      <iframe className="gemit-frame" title="Steering report" sandbox="allow-scripts" srcDoc={report.html} />
    </section>
  );
}

export const gemitPage = defineConsolePage({
  id: "gemit",
  title: "Gemit",
  icon: "◈",
  order: 40,
  phase: "observe",
  category: "usage",
  group: "share",
  fullWidth: true,
  route: "#/gemit",
  component: GemitPage,
});

import { useEffect, useState, type ReactNode } from "react";
import type { Gem, Scorecard } from "../../api/routes.js";
import { openScorecardStream } from "../Mine/scorecardStream.js";
import { fmtTokens } from "./data.js";
import { useCountUp } from "./useCountUp.js";
import { useRevealData } from "./useRevealData.js";
import { useFirstGem, type FirstGemCandidate, type FirstGemPhase } from "./useFirstGem.js";
import { useHomeState } from "../../shell/useHomeState.js";

export type RevealMode = "first-run" | "ceremony";

// Literal, reused in two places: the Codex-heavy goldmine section (prominent) and the
// bottom footnote everywhere else (quiet) — never both at once, see RevealContent.
const CLAUDE_ONLY_TEXT = "workflow analysis reads your Claude sessions · usage covers Claude + Codex";

const MASTHEAD_DATE = () => new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

function Masthead({ label }: { label: string }) {
  return (
    <>
      <div className="reveal-masthead">
        <span className="reveal-brand">AgentGem</span>
        <span className="reveal-date">{label} · {MASTHEAD_DATE()}</span>
      </div>
      <hr className="reveal-rule-2" />
      <hr className="reveal-rule-1" />
    </>
  );
}

/** Masthead + hairlines only — the render used while `useHomeState` is still
 *  loading, so the real mode (first-run / ceremony / returning) isn't known yet.
 *  Deliberately distinct from the first-run consent screen: it must never imply
 *  a decision (consent copy, a button) before we know which mode applies. */
export function RevealLoadingShell() {
  return (
    <div className="reveal">
      <Masthead label="Loading" />
      <RevealSkeleton />
    </div>
  );
}

function RevealSkeleton() {
  return (
    <div className="reveal-skel" aria-busy="true" aria-label="Loading your session reveal">
      <div className="reveal-skel-line" />
      <div className="reveal-skel-ledger">
        <span className="reveal-skel-pill" />
        <span className="reveal-skel-pill" />
        <span className="reveal-skel-pill" />
        <span className="reveal-skel-pill" />
      </div>
    </div>
  );
}

function rankConfidence(c: "high" | "medium" | "low"): number {
  return c === "high" ? 2 : c === "medium" ? 1 : 0;
}

/** The CTA's candidate workflow: highest confidence first, then most recently
 *  seen — per the brief this is described as "the top battle-tested workflow",
 *  which in practice is whatever sorts to the front of that ordering. Carries
 *  its project root + key (not just display fields) so it can be handed
 *  straight to `POST /scorecard/build`'s `selections: [{root, keys}]` shape. */
function pickTopWorkflow(scorecard: Scorecard): FirstGemCandidate | null {
  const all = scorecard.projects.flatMap((p) => p.workflows.map((w) => ({ ...w, root: p.root })));
  if (all.length === 0) return null;
  const sorted = [...all].sort((a, b) => rankConfidence(b.confidence) - rankConfidence(a.confidence) || b.lastSeenMs - a.lastSeenMs);
  const top = sorted[0];
  return { root: top.root, key: top.key, name: top.name, sessions: top.sessions };
}

function heroSentenceText(scorecard: Scorecard): string {
  const parts = [`${scorecard.breadth} reusable workflows`];
  if (scorecard.battleTested > 0) parts.push(`${scorecard.battleTested} battle-tested`);
  if (scorecard.portable > 0) parts.push(`${scorecard.portable} ready to share`);
  return `You're sitting on a goldmine: ${parts.join(", ")}.`;
}

// "mined from" prefix + the scope clause both exist so the reveal is honest about
// what it actually scanned: the scorecard silently caps discovery at the most
// recent `projectsScanned` projects, so the surface must say so (eng-review
// requirement) rather than imply the full history was covered.
function LedgerRow({ display, projectsScanned }: { display: number[]; projectsScanned: number }) {
  const [sessions, days, hours, tokens] = display;
  return (
    <>
      <div className="reveal-ledger">
        <span className="reveal-ledger-item">mined from <b>{sessions}</b> sessions</span>
        <span className="reveal-ledger-item"><b>{days}</b> days</span>
        <span className="reveal-ledger-item"><b>{hours}</b> active hours</span>
        <span className="reveal-ledger-item"><b>{fmtTokens(tokens)}</b> tokens</span>
      </div>
      {projectsScanned > 0 && (
        <p className="reveal-scope">across your {projectsScanned} most recent projects</p>
      )}
    </>
  );
}

/** Which asset clauses are suppressed (a zero count) get exactly one earn-it
 *  line explaining why — never silent. Battle-tested-zero and portable-zero
 *  each get their own line; if both are zero, one combined line replaces both
 *  rather than stacking two. */
function earnItLine(showBattleTested: boolean, showPortable: boolean): string | null {
  if (!showBattleTested && !showPortable) {
    return "nothing battle-tested or portable yet — workflows earn both by proving out across sessions, then running outside this machine";
  }
  if (!showBattleTested) {
    return "none battle-tested yet — workflows earn it by proving out across sessions.";
  }
  if (!showPortable) {
    return "nothing portable yet — battle-tested workflows become portable when they run outside this machine";
  }
  return null;
}

function GoldmineHero({
  scorecard, display, projectsScanned, candidate, buildPhase, onBuildClick,
}: {
  scorecard: Scorecard; display: number[]; projectsScanned: number;
  candidate: FirstGemCandidate | null; buildPhase: FirstGemPhase; onBuildClick: () => void;
}) {
  const [breadth, battleTested, portable] = display;
  const showBattleTested = scorecard.battleTested > 0;
  const showPortable = scorecard.portable > 0;
  const unreadCount = Math.max(0, projectsScanned - scorecard.projects.length);
  const earnIt = earnItLine(showBattleTested, showPortable);

  return (
    <>
      <h1 className="reveal-hero">
        <span className="reveal-kicker">You&#39;re sitting on a goldmine:</span>{" "}
        <b>{breadth} reusable workflows</b>
        {showBattleTested && <> — <b className="reveal-emerald">{battleTested} battle-tested</b>{showPortable ? "," : ""}</>}
        {showPortable && <> {showBattleTested ? "" : "—"} <b>{portable} ready to share</b></>}.
      </h1>
      {earnIt && <p className="reveal-earnit">{earnIt}</p>}
      {scorecard.degraded && unreadCount > 0 && (
        <p className="reveal-degrade">couldn&#39;t read {unreadCount} projects</p>
      )}
      {candidate && (
        <div className="reveal-below">
          <button type="button" className="reveal-cta" onClick={onBuildClick} disabled={buildPhase === "building"}>
            Turn your top workflow into a Gem
          </button>
          <p className="reveal-cta-sub">assembled now — deep distill keeps improving it in the background.</p>
          <p className="reveal-candidate">{candidate.name} — from {candidate.sessions} sessions</p>
          {buildPhase === "error" && (
            <p className="reveal-build-error">couldn&#39;t assemble the gem — try again</p>
          )}
        </div>
      )}
      {scorecard.gaps.length > 0 && (
        <p className="reveal-gaps">Still unmined: {scorecard.gaps.slice(0, 3).join(" · ")}</p>
      )}
    </>
  );
}

/** The first-gem ceremony: shown IN PLACE of the reveal's normal body once the
 *  CTA's build resolves — a certification moment (emerald, per this surface's
 *  color semantics), not another data screen. One continue action, which hands
 *  the built gem's selection to Curate's existing Publish-flow deep-link
 *  (`setPendingContribution` + `#/curate` — the same one-shot hand-off
 *  "Share my setup" and a lesson's "Share" already use). */
function GemCeremony({ gem, candidate, onContinue }: { gem: Gem; candidate: FirstGemCandidate | null; onContinue: () => void }) {
  return (
    <div className="reveal-ceremony">
      <p className="reveal-ceremony-kicker">Your first gem — assembled</p>
      <h2 className="reveal-ceremony-name">{gem.name}</h2>
      <p className="reveal-ceremony-sub">
        built from <b>{candidate?.name ?? gem.name}</b>
        {candidate ? ` — ${candidate.sessions} sessions strong` : ""}. Deep distill is still refining it in the background.
      </p>
      <button type="button" className="reveal-ceremony-continue" onClick={onContinue}>Open in Curate</button>
    </div>
  );
}

function DiagnosticBlock({ path, onRetry }: { path: string; onRetry: () => void }) {
  return (
    <div className="reveal-diagnostic">
      <p className="reveal-diagnostic-text">Couldn&#39;t load your session reveal.</p>
      <p className="reveal-diagnostic-path">{path}</p>
      <button type="button" className="reveal-retry" onClick={onRetry}>Try again</button>
    </div>
  );
}

type RevealDataProps = ReturnType<typeof useRevealData>;

function RevealContent({ mode, onDismiss, data, apiBase }: { mode: RevealMode; onDismiss: () => void; data: RevealDataProps; apiBase: string }) {
  const { summary, summaryError, scorecard, phase, slow, streamError, retry } = data;

  // A separate `useHomeState` instance from the one Observe/index.tsx uses to pick
  // the reveal's mode: each mount owns its own copy (see useHomeState's module doc),
  // so posting here never flips this page's already-rendered Observe out from under
  // the ceremony — it just persists the real state server-side for the NEXT mount
  // (after "Open in Curate" navigates away) to read as "returning".
  const homeState = useHomeState(apiBase);
  const firstGem = useFirstGem(apiBase, () => {
    homeState.setUnlocked(true);
    homeState.setRevealSeen(true);
  });
  const candidate = scorecard ? pickTopWorkflow(scorecard) : null;

  const usage = summary?.usage ?? { sessions: 0, spanDays: 0, activeMs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 };
  const activeHours = Math.round(usage.activeMs / 3_600_000);
  const totalTokens = usage.tokensIn + usage.tokensOut + usage.tokensCache;
  const ledgerDisplay = useCountUp([usage.sessions, usage.spanDays, activeHours, totalTokens]);
  const heroDisplay = useCountUp([scorecard?.breadth ?? 0, scorecard?.battleTested ?? 0, scorecard?.portable ?? 0]);

  const cold = !!summary && summary.gate.usageEmpty && summary.gate.claudeBelowGate;
  const codexHeavy = !!summary && !summary.gate.usageEmpty && summary.gate.claudeBelowGate;

  // Only announce the goldmine hero sentence — never in cold/Codex-heavy, where the
  // scorecard scan may still finish in the background but that sentence isn't the
  // one rendered on screen.
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    if (phase === "done" && scorecard && !cold && !codexHeavy) setAnnounced(heroSentenceText(scorecard));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const failedEndpoint = summaryError ? "/api/home/summary" : streamError && !scorecard ? "/api/scorecard/stream" : null;

  let body: ReactNode;
  if (firstGem.phase === "built" && firstGem.gem) {
    body = <GemCeremony gem={firstGem.gem} candidate={candidate} onContinue={firstGem.openInCurate} />;
  } else if (failedEndpoint) {
    body = <DiagnosticBlock path={failedEndpoint} onRetry={retry} />;
  } else if (!summary) {
    body = <RevealSkeleton />;
  } else if (cold) {
    body = (
      <p className="reveal-prospecting">
        Not enough history to assay yet — AgentGem needs about 10 sessions. Keep working with your agent.
      </p>
    );
  } else if (codexHeavy) {
    body = (
      <>
        <LedgerRow display={ledgerDisplay} projectsScanned={summary.projectsScanned} />
        <p className="reveal-claude-only">{CLAUDE_ONLY_TEXT}</p>
      </>
    );
  } else {
    body = (
      <>
        <LedgerRow display={ledgerDisplay} projectsScanned={summary.projectsScanned} />
        {scorecard
          ? <GoldmineHero
              scorecard={scorecard} display={heroDisplay} projectsScanned={summary.projectsScanned}
              candidate={candidate} buildPhase={firstGem.phase}
              onBuildClick={() => { if (candidate) firstGem.build(candidate); }}
            />
          : slow
            ? <p className="reveal-assaying">still assaying your workflows…</p>
            : <p className="reveal-scanning">scoring your goldmine…</p>}
      </>
    );
  }

  // The ceremony is a full takeover of the reveal's content area — the returning-user
  // dismiss button and the Claude-only footnote belong to the data screen it replaced.
  const ceremonyShowing = firstGem.phase === "built" && !!firstGem.gem;

  return (
    <div className="reveal">
      <Masthead label={mode === "ceremony" ? "Welcome back" : "First reading"} />
      {body}
      {mode === "ceremony" && !ceremonyShowing && (
        <button type="button" className="reveal-dismiss" onClick={onDismiss}>Take me to my console</button>
      )}
      <p className="reveal-sr-only" aria-live="polite">{announced}</p>
      {/* Codex-heavy already shows this exact sentence, prominently, as the goldmine
          section itself — a second identical line at the bottom would just be noise. */}
      {summary && !failedEndpoint && !codexHeavy && !ceremonyShowing && (
        <p className="reveal-footnote">{CLAUDE_ONLY_TEXT}</p>
      )}
    </div>
  );
}

/** The consented reveal: masthead + the fetched-state machine (loading / cold /
 *  Codex-heavy / slow / rich / degraded / hard-failure). First-run visitors sit
 *  behind a hard consent gate (zero fetches until "Scan my sessions" is
 *  clicked); existing users skip the gate — their prior use implies consent —
 *  and land straight in the fetched-state machine as a one-time "what's
 *  changed" ceremony (Task 8 finalizes its copy) with a dismiss button. */
export function Reveal({
  apiBase, mode, onDismiss, openStream,
}: { apiBase: string; mode: RevealMode; onDismiss: () => void; openStream?: typeof openScorecardStream }) {
  const [consented, setConsented] = useState(mode === "ceremony");
  const data = useRevealData(apiBase, consented, { openStream });

  if (!consented) {
    return (
      <div className="reveal">
        <Masthead label="First reading" />
        <p className="reveal-consent-text">
          AgentGem reads your local session history — locally; nothing leaves this machine — to find what
          you&#39;ve built.
        </p>
        <button type="button" className="reveal-cta" onClick={() => setConsented(true)}>Scan my sessions</button>
      </div>
    );
  }

  return <RevealContent mode={mode} onDismiss={onDismiss} data={data} apiBase={apiBase} />;
}

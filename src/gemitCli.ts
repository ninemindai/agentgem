// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemitCli.ts
//
// `agentgem gemit [--dir <claude-home>] [--out <file>] [--theme rpg] [--no-open]`
// Score the operator's last 30 days of local coding-agent sessions and write a
// self-contained HTML steering report. Fully local and deterministic: existing
// detectors over local transcripts, no LLM, no server, nothing published.
// Exit codes: 0 success (including the insufficient-data doorway), 2 usage.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { collectGemitInputs } from "./gemit/collect.js";
import { computeGemitData, type GemitData } from "./gemit/score.js";
import { GEMIT_CMD, renderRpgTheme, TIER_NAMES, type RpgRenderOpts } from "./gemit/themeRpg.js";
import { openInBrowser } from "./gemit/openBrowser.js";
import { buildGemitShare, gemitShareUrls } from "./gemit/share.js";
import { postGemPublish } from "@agentgem/app/gem/gemPublishClient";

export const GEMIT_HELP = `agentgem gemit — score your agent steering into a local report

Usage:
  agentgem gemit [options]

Options:
  --dir <path>     Claude home to scan (default: ~/.claude)
  --out <file>     Report path (default: <agentgem-home>/reports/gemit-<date>.html)
  --theme <name>   Report theme (rpg)
  --no-open        Don't open the report in the browser
                   (opens the app's Gemit screen when the local app is
                   running — it can publish and share; otherwise the file)
  --share          Publish the report as an unlisted card on app.agentgem.ai
  --include-usage  With --share: also ship your coding agents and your
                   most-used skill/subagent names (off by default)
  --yes, -y        Skip the pre-publish confirmation
  -h, --help       Show this help

Scores the last 30 days (context discipline · process quality · setup maturity)
with the same deterministic detectors the console uses. Local only — nothing
leaves this machine unless you pass --share, which uploads ONLY the rendered
report (scores, counts, window dates — no skill/subagent names, no project
names, no transcripts) after showing you exactly what ships. Adding
--include-usage also ships your coding agents and most-used skill/subagent
names; project names and transcripts never ship under any flag.`;

export interface GemitArgs {
  dir?: string;
  out?: string;
  theme: string;
  open: boolean;
  help: boolean;
  share: boolean;
  yes: boolean;
  includeUsage: boolean;
}

const THEMES = ["rpg"];

export function parseGemitArgs(argv: string[]): GemitArgs | { error: string } {
  const args: GemitArgs = { theme: "rpg", open: true, help: false, share: false, yes: false, includeUsage: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--no-open") args.open = false;
    else if (a === "--share") args.share = true;
    else if (a === "--include-usage") args.includeUsage = true;
    else if (a === "-y" || a === "--yes") args.yes = true;
    else if (a === "--dir" || a === "--out" || a === "--theme") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) return { error: `${a} requires a value` };
      if (a === "--dir") args.dir = v;
      else if (a === "--out") args.out = v;
      else args.theme = v;
      i++;
    } else return { error: `unknown option '${a}'` };
  }
  if (!THEMES.includes(args.theme)) {
    return { error: `unknown theme '${args.theme}' (available: ${THEMES.join(", ")})` };
  }
  // Alone it does nothing — the local report always shows usage. Rejecting beats silently
  // accepting a flag the operator believes widened (or restricted) something.
  if (args.includeUsage && !args.share) {
    return { error: "--include-usage only applies with --share" };
  }
  return args;
}

export interface GemitCliDeps {
  collect?: typeof collectGemitInputs;
  compute?: typeof computeGemitData;
  render?: (data: GemitData, opts?: RpgRenderOpts) => string;
  writeFile?: (path: string, content: string) => void;
  open?: (path: string) => void;
  out?: (line: string) => void;
  err?: (line: string) => void;
  isTTY?: boolean;
  nowMs?: number;
  /** Resolve the bound GitHub login, running the device flow inline if needed. null = failed. */
  ensureBound?: (out: (line: string) => void) => Promise<string | null>;
  publish?: typeof postGemPublish;
  /** Interactive y/N prompt; only called on a TTY when --yes is absent. */
  confirm?: (question: string) => Promise<boolean>;
  /** Base URL of a running local console, or null. Decides file:// vs the app's screen. */
  detectConsole?: () => Promise<string | null>;
}

/** What the operator sees when a bind is needed, and whether we open the page for them.
 *  The console's ConnectGitHub button copies the code and opens the browser; the CLI used to
 *  print instructions and go silent for five minutes, which is how a real user wandered off
 *  and hit the timeout. Pure, so the decision is testable without a network or a terminal. */
export function bindPrompt(
  dc: { verificationUri: string; userCode: string; expiresInSec: number },
  isTTY: boolean,
): { lines: string[]; open: string | null } {
  const lines = [
    "Publishing needs a one-time GitHub bind (once, then never again):",
    "",
    `    code:  ${dc.userCode}`,
    "",
    isTTY
      ? `  Opening ${dc.verificationUri} — paste the code there and authorize.`
      : `  Open ${dc.verificationUri} and enter that code.`,
    `  Waiting up to ${Math.round(dc.expiresInSec / 60)} minutes. Ctrl-C to stop; your report is already saved.`,
  ];
  // Never launch a browser off a TTY: that is CI, a pipe, or the desktop host, where an
  // opener is either useless or actively wrong.
  return { lines, open: isTTY ? dc.verificationUri : null };
}

/** Periodic proof of life while we wait, because the gap between "here is your code" and
 *  either success or a timeout was otherwise completely silent — which is how a real user
 *  concluded nothing was happening, walked away, and came back to a timeout.
 *
 *  The cadence is deliberately uneven. A tick fires per poll (every 5s), and printing all of
 *  them over a 15-minute budget is 180 lines of near-identical text — silence replaced by
 *  spam. One line at 30s catches the person about to give up early, then every two minutes is
 *  enough to prove the process is alive: about eight lines for a full wait.
 *
 *  Only the first line carries the URL. Every line carries the code, since that is the part
 *  the operator has to act on and the original instructions have scrolled away by then.
 *
 *  Returns the callback rather than taking a clock, so a test can drive it with synthetic
 *  elapsed values and assert the cadence directly. */
export function bindHeartbeat(
  dc: { verificationUri: string; userCode: string },
  out: (l: string) => void,
): (p: { elapsedSec: number; remainingSec: number }) => void {
  const FIRST_AFTER_SEC = 30;
  const THEN_EVERY_SEC = 120;
  let lastAt = 0;
  let said = 0;
  return ({ elapsedSec, remainingSec }) => {
    // Never announce "0s left" and then immediately time out.
    if (remainingSec <= 0) return;
    if (elapsedSec - lastAt < (said === 0 ? FIRST_AFTER_SEC : THEN_EVERY_SEC)) return;
    lastAt = elapsedSec;
    said += 1;
    const m = Math.floor(remainingSec / 60);
    const s = remainingSec % 60;
    const left = m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
    out(said === 1
      ? `  … still waiting for GitHub — ${left} left. Code ${dc.userCode} at ${dc.verificationUri}`
      : `  … still waiting — ${left} left. Code ${dc.userCode}`);
  };
}

export async function defaultEnsureBound(
  out: (l: string) => void,
  isTTY = Boolean(process.stdout.isTTY),
  openBrowser: (t: string) => void = openInBrowser,
): Promise<string | null> {
  const { readBindingStatus, bindConfig, startDeviceBind, completeDeviceBind } = await import("@agentgem/app/bind/bindCore");
  const st = readBindingStatus();
  if (st.bound && st.login) return st.login;
  const cfg = bindConfig();
  const dc = await startDeviceBind(cfg);
  const prompt = bindPrompt(dc, isTTY);
  prompt.lines.forEach(out);
  if (prompt.open) openBrowser(prompt.open);
  try {
    const res = await completeDeviceBind(cfg, {
      deviceCode: dc.deviceCode, interval: dc.interval,
      // A CLI can afford to wait for the code's real expiry; the console route cannot, and
      // deliberately keeps the shorter in-request default. See pollForToken.
      budgetSec: dc.expiresInSec, onPending: bindHeartbeat(dc, out),
    });
    return res.bound ? res.login : null;
  } catch (e) {
    // pollForToken throws when the budget runs out, on access_denied, and on an expired
    // code. Letting that escape printed a Node stack trace for the ordinary case of
    // "didn't finish signing in yet", which reads like a crash rather than a timeout.
    out(`Bind not completed: ${e instanceof Error ? e.message.replace(/^device flow: /, "") : String(e)}`);
    return null;
  }
}

// Is a local console listening? A `file://` report can never publish — signing needs the
// producer keypair, which a browser document cannot read — so when the app IS running it is
// the strictly better place to land: same card, plus a Publish button and live share links.
// Best-effort and fast: a short timeout, and any failure just means "no app".
export async function detectConsole(
  fetchImpl: typeof fetch = fetch,
  port: string | number = process.env.PORT ?? 4317,
): Promise<string | null> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetchImpl(`${base}/healthz`, { signal: AbortSignal.timeout(700) });
    return res.ok ? base : null;
  } catch {
    return null; // not running, wrong port, or refused — the file is the fallback either way
  }
}

// Anything the operator typed during an earlier blocking step — notably the multi-minute
// device-flow wait — is still sitting in the terminal buffer when this prompt opens, and
// readline consumes it as the answer. Treating an unrecognised answer as "no" turned that
// stray keystroke into a silent "Not published.", so the whole scan had to be re-run. An
// answer that is not clearly yes or no now re-asks instead of deciding for the operator.
/** yes / no / "say that again". Split out from the prompt loop so the rule that a stray
 *  newline is NOT a "no" is directly testable, without a terminal. */
export function readConfirmAnswer(raw: string): boolean | null {
  const a = raw.trim();
  if (/^y(es)?$/i.test(a)) return true;
  if (/^n(o)?$/i.test(a)) return false;
  return null;
}

async function defaultConfirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = readConfirmAnswer(await rl.question(question));
      if (answer !== null) return answer;
      // Empty (a buffered newline) or unrecognised: say so and ask again.
      rl.write("Please answer y or n.\n");
    }
    return false; // three unusable answers: fail closed, since publishing is the risky side
  } finally { rl.close(); }
}

export async function runGemitCommand(argv: string[], deps: GemitCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const parsed = parseGemitArgs(argv);
  if ("error" in parsed) {
    err(`gemit: ${parsed.error}`);
    err(GEMIT_HELP);
    return 2;
  }
  if (parsed.help) {
    out(GEMIT_HELP);
    return 0;
  }

  const nowMs = deps.nowMs ?? Date.now();
  const collect = deps.collect ?? collectGemitInputs;
  const compute = deps.compute ?? computeGemitData;
  const render = deps.render ?? renderRpgTheme;
  const write = deps.writeFile ?? ((p: string, c: string) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c);
  });

  out("Scanning sessions (last 30 days)…");
  // cache:true — reuse the on-disk per-session scores (shared with the console process).
  // Ignored when --dir names an alternate home.
  const { qualifying, scored } = await collect(parsed.dir, nowMs, { cache: true });
  const data = compute(qualifying, scored, nowMs);

  // agentgemHome() is the home ROOT (AGENTGEM_HOME override or ~); state lives under .agentgem.
  const outPath = resolve(parsed.out ?? join(agentgemHome(), ".agentgem", "reports", `gemit-${data.windowTo}.html`));
  write(outPath, render(data));

  if (data.insufficient) {
    out(`Not enough steering yet: ${data.qualifyingSessions} substantial session(s) in the last 30 days (need 5).`);
  } else {
    out(`Tier: ${TIER_NAMES[data.tierLevel - 1]} — ${data.composite}/100`);
    out(`  Context discipline ${data.ctx} · Process quality ${data.proc} · Setup maturity ${data.setup}`);
    out(`  Scored ${data.scoredSessions} of ${data.qualifyingSessions} sessions across ${data.projects} projects.`);
  }
  out(`Report: ${outPath}`);
  // Publishing shipped behind a flag nobody could see: a plain run used to end here, so
  // operators reasonably concluded there was no way to share at all. Name the path.
  if (!parsed.share && !data.insufficient) out(`Publish & share: ${GEMIT_CMD} --share`);

  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);

  if (parsed.share) {
    if (data.insufficient) {
      out("Nothing to share yet — a score appears once 5 substantial sessions exist in the window.");
      return 0;
    }
    if (!parsed.yes && !isTTY) {
      err("gemit: --share needs a terminal to confirm (or pass --yes).");
      return 2;
    }
    const login = await (deps.ensureBound ?? ((o: (l: string) => void) => defaultEnsureBound(o, isTTY, deps.open ?? openInBrowser)))(out);
    if (!login) {
      // The report is already written at this point, so say so: the scan is not wasted and
      // a re-run picks up the cached scores rather than re-scanning from scratch.
      err("gemit: publishing needs a GitHub bind. Your report is still at:");
      err(`  ${outPath}`);
      err("Re-run `npx -y @ninemind/agentgem gemit --share` when you're ready to finish signing in.");
      return 1;
    }
    const built = buildGemitShare({ data, login, includeUsage: parsed.includeUsage });
    const sharePath = outPath.replace(/\.html$/, "") + ".share.html";
    write(sharePath, built.html);
    out("");
    out("Ready to publish an UNLISTED card (visible only via its link):");
    out(`  ${built.manifest.description}`);
    out(`  Card: ${built.gemKey} v${built.version} — exact file that ships: ${sharePath}`);
    // The consent line moves WITH the flag. A widening that leaves the old promise on
    // screen is worse than no disclosure — the operator would be reading a false one.
    out(parsed.includeUsage
      ? "  Ships: scores, counts, window dates, your coding agents, and your most-used skill/subagent names. Never: projects, transcripts."
      : "  Ships: scores, counts, window dates. Never: coding agents, skill/subagent names, projects, transcripts.");
    if (!parsed.yes) {
      const okay = await (deps.confirm ?? defaultConfirm)("Publish? [y/N] ");
      if (!okay) {
        out("Not published.");
        return 0;
      }
    }
    const { loadOrCreateIdentity } = await import("@agentgem/model");
    const r = await (deps.publish ?? postGemPublish)({
      manifest: built.manifest, archiveBase64: built.archiveBase64, identity: loadOrCreateIdentity(),
    });
    if (!r.shared) {
      err(`gemit: share rejected (${r.rejected})${r.rejected === "conflict" ? " — that key belongs to another account" : ""}`);
      return 1;
    }
    const urls = gemitShareUrls(built.gemKey, data);
    // Re-render the LOCAL report now that a real URL exists: the first write could only
    // offer the copyable `--share` command, and that CTA is now stale. This copy is the
    // one that gets opened below, so the buttons the operator lands on are live links.
    write(outPath, render(data, { share: urls }));
    out(`Published: ${urls.shareUrl}`);
    out(`  X:        ${urls.x}`);
    out(`  LinkedIn: ${urls.linkedin}`);
    out(`  Facebook: ${urls.facebook}`);
  }

  // Prefer the app when it is running. The file is still written and its path still printed —
  // it is the durable local artifact — but the app's screen is the one that can actually
  // publish and share, so landing there beats landing on a document whose only offer is a
  // command to copy. It re-scores on arrival (it cannot trust numbers posted by a browser),
  // which the panel reports with live session counts.
  if (parsed.open && isTTY) {
    const base = await (deps.detectConsole ?? detectConsole)();
    if (base) {
      out(`Opening in the app: ${base}/#/gemit`);
      (deps.open ?? openInBrowser)(`${base}/#/gemit`);
    } else {
      (deps.open ?? openInBrowser)(outPath);
    }
  }
  return 0;
}

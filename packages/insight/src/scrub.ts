// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/scrub.ts
//
// Field-aware, default-deny scrubber for builtin tool_use inputs captured during
// transcript distillation (see docs/proposals/skill-distillation-from-transcripts.md
// §3a). Unlike redact.ts (which redacts secret VALUES in a structured config),
// this keeps only an allowlisted structural slice per builtin and DROPS everything
// else — removing the file-content/PII class by construction rather than blocklist.
//
// Output per step: { verb, arg } — a coarse low-cardinality `verb` for procedure
// recurrence (§3c) and a minimal scrubbed `arg` for the agent.

export interface ScrubbedStep {
  verb: string;
  arg: string;
  /**
   * A finer verb, present only when `verb` hides which script ran.
   *
   * `bashVerb` is deliberately low-cardinality so that procedure RECURRENCE is detectable —
   * `python3 a.py` and `python3 b.py` must collapse to the same token for an n-gram to find a
   * repeated shape. That is right for detection and wrong for NAMING: a consumer reporting the
   * procedure back to a human ("run finalize_svg.py, then svg_to_pptx.py") cannot tell those two
   * steps apart, so every script-driven pipeline reads as `Bash:python3 -> Bash:python3`.
   *
   * `verbDetail` carries `Bash:<script basename>` for exactly that case, leaving `verb` untouched
   * so no existing consumer changes behaviour. Opt in where naming matters; keep using `verb`
   * where recurrence matters.
   *
   * PRIVACY: this retains nothing new. The basename is a projection of the command that `arg`
   * already keeps verbatim (de-homed and token-scrubbed), so it is a different view of retained
   * data, not an additional class of it.
   */
  verbDetail?: string;
}

// Token-level secret detection. redact.ts redacts the WHOLE value and can lean on
// bare keywords because it has key/value structure; here we scrub free-text command
// tokens, where bare words like "secret"/"token"/"password" legitimately appear in
// filenames and commit messages (`cat secret.env`). So the rule is intentionally
// narrower: a token is secret only if it is HIGH-ENTROPY or carries a known secret
// PREFIX — never a plain dictionary keyword. (Short keyword-less secrets survive;
// that residual risk is accepted under the draft-only review gate — proposal §3a.)
const SECRET_PREFIX_RE = /^(sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[a-z]-|AKIA|ASIA|glpat-)/;
function looksLikeSecretToken(t: string): boolean {
  if (t.length >= 32 && /^[A-Za-z0-9_-]+$/.test(t)) return true; // high entropy
  if (t.length >= 8 && SECRET_PREFIX_RE.test(t)) return true; // prefixed token
  return false;
}

// Rewrite $HOME-absolute prefixes to ~ and any /Users/<name>/ to ~/, so paths
// never carry a username. Applied before token scrub.
function dehomePaths(s: string): string {
  const home = process.env.HOME;
  let out = home ? s.split(home).join("~") : s;
  out = out.replace(/\/Users\/[^/\s]+\//g, "~/");
  return out;
}

// Token-scrub a free-text arg: de-home paths, then replace any secret-looking
// whitespace token with <redacted>, leaving the rest of the command intact.
// Exported as the *preserve-and-redact* path (vs. scrubStep's default-deny drop):
// the transcript viewer (inspectSession.ts) reuses this to make verbatim message
// text and tool I/O secret-safe without discarding the content itself.
export function scrubText(s: string): string {
  return dehomePaths(s)
    .split(/(\s+)/) // keep separators so spacing is preserved
    .map((tok) => (/\s/.test(tok) ? tok : redactToken(tok)))
    .join("");
}

/** scrubText + a visible-truncation valve: caps very large content so a single
 *  Read/scan can't ship megabytes per open. The cut is marked, not silent. */
export function scrubTruncate(s: string, max = 50_000): string {
  const out = scrubText(s);
  return out.length > max ? out.slice(0, max) + "\n…(truncated)" : out;
}

// A token may carry a secret embedded in surrounding syntax (https://SECRET@host).
// Redact the embedded secret, not the whole token, so structure survives.
function redactToken(tok: string): string {
  if (!tok) return tok;
  return tok
    .split(/([^A-Za-z0-9_-]+)/) // split on non-identifier runs, keep them
    .map((part) => (/^[A-Za-z0-9_-]+$/.test(part) && looksLikeSecretToken(part) ? "<redacted>" : part))
    .join("");
}

/** Share-time cleanup for human-facing description text: strip URLs + absolute
 * paths and cap length, so a shared gem's skill descriptions don't leak links or
 * internal context. NOT a secret scrubber (scrubProse already handles secrets). */
export function sanitizeShareText(s: string, max = 160): string {
  let out = s
    .replace(/https?:\/\/\S+/g, "")          // URLs
    .replace(/\b(?:\/[\w.-]+){2,}\b/g, "")    // absolute-ish file paths
    .replace(/\s+/g, " ")
    .trim();
  if (out.length > max) out = out.slice(0, max - 1).trimEnd() + "…";
  return out;
}

// Scrub free-text prose (mission-hint task/outcome). Same token scrub + de-home as
// command args, plus a hard length cap — this is the one place free text is kept,
// so it is deliberately short and low-detail (proposal §3b).
export function scrubProse(s: string, maxLen = 280): string {
  const scrubbed = scrubText(s).trim();
  if (scrubbed.length <= maxLen) return scrubbed;
  return scrubbed.slice(0, maxLen) + "…";
}

// Coarse procedure verb: "git commit -m fix" -> "Bash:git commit", "cd /x" ->
// "Bash:cd", "/usr/bin/npx vitest" -> "Bash:npx vitest". argv0 is basenamed; the
// 2nd token counts as a subcommand ONLY if it's a clean lowercase word — a path,
// filename, flag, or quoted arg is NOT a subcommand, so it never inflates the verb.
function bashVerb(command: string): string {
  const toks = command.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return "Bash";
  const argv0 = (toks[0].split("/").pop() || toks[0]).replace(/[;|&]+$/, "");
  if (!argv0) return "Bash";
  const sub = toks[1] && /^[a-z][a-z0-9-]*$/.test(toks[1]) ? ` ${toks[1]}` : "";
  return `Bash:${argv0}${sub}`;
}

// Runners whose argv0 tells you nothing about the work: the script is the verb. `bashVerb`
// can't use the 2nd token here because a path fails its clean-lowercase-word test (by design —
// that guard is what stops paths and flags from inflating the verb).
const SCRIPT_RUNNER_RE = /^(python3?|node|npx|bun|deno|bash|sh|zsh|uvx|ruby|perl)$/;
const SCRIPT_ARG_RE = /(^|[\s/])([\w.-]+\.(?:py|mjs|cjs|js|ts|tsx|sh|rb|pl))(\s|$)/;

// `Bash:<script basename>` when the coarse verb collapsed a script runner, else undefined.
// Basename only: a directory path would re-introduce the location detail dehomePaths exists to
// blunt, and the basename is what names a step.
function bashVerbDetail(command: string): string | undefined {
  const toks = command.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return undefined;
  const argv0 = (toks[0].split("/").pop() || toks[0]).replace(/[;|&]+$/, "");
  if (!SCRIPT_RUNNER_RE.test(argv0)) return undefined;
  const m = SCRIPT_ARG_RE.exec(command);
  const base = m?.[2]?.split("/").pop();
  return base ? `Bash:${base}` : undefined;
}

function str(input: unknown, key: string): string {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
}

// Default-deny: each builtin keeps only an allowlisted structural slice; every
// other field (file contents, agent prompts, tool output, unknown fields) is
// dropped, not scrubbed — so the file-content/PII class is removed by construction.
export function scrubStep(tool: string, input: unknown): ScrubbedStep {
  switch (tool) {
    case "Bash": {
      const command = str(input, "command");
      const detail = bashVerbDetail(command);
      return { verb: bashVerb(command), arg: scrubText(command), ...(detail ? { verbDetail: detail } : {}) };
    }
    // Edit/Write/NotebookEdit: keep the path; DROP old_string/new_string/content.
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return { verb: tool, arg: scrubText(str(input, "file_path") || str(input, "notebook_path")) };
    // Read/Grep/Glob: keep the path/pattern; DROP file contents and match output.
    case "Read":
    case "Grep":
    case "Glob":
      return { verb: tool, arg: scrubText(str(input, "file_path") || str(input, "path") || str(input, "pattern")) };
    // Task/agent spawns: keep the short description; DROP the prompt.
    case "Task":
    case "Agent": {
      const sub = str(input, "subagent_type");
      return { verb: sub ? `${tool}:${sub}` : tool, arg: scrubText(str(input, "description")) };
    }
    // Unknown tool: verb only, entire input dropped.
    default:
      return { verb: tool, arg: "" };
  }
}

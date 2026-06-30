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
function scrubText(s: string): string {
  return dehomePaths(s)
    .split(/(\s+)/) // keep separators so spacing is preserved
    .map((tok) => (/\s/.test(tok) ? tok : redactToken(tok)))
    .join("");
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
      return { verb: bashVerb(command), arg: scrubText(command) };
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

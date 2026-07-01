// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Fetch a skill's one-line description WITHOUT installing it, by shelling out to
// `skills use <source>@<skillId>` — the CLI resolves the ref (a shallow git clone
// under the hood) and prints the SKILL.md wrapped in <SKILL.md>…</SKILL.md>. We parse
// only the frontmatter `description:`. Used to enrich Discover's AI re-rank prompt with
// real descriptions (name + installs alone are thin signal). This is the canonical
// resolver, so it beats guessing GitHub SKILL.md paths or the OIDC-walled registry API.
// Mirrors skillsInstall.ts's spawn posture. Never throws: any failure yields "" and the
// candidate is simply described by name.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";

const execFileP = promisify(execFile);

const SOURCE_RE = /^[\w.-]+\/[\w.-]+$/; // owner/repo
const ID_RE = /^[\w.-]+$/;             // skill slug

export type DescribeRun = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

// `npx` fixed binary; cwd=homedir so the CLI can't latch onto the server checkout as a
// "project". 60s cap covers the clone `skills use` performs.
const defaultRun: DescribeRun = async (args) => {
  const { stdout, stderr } = await execFileP("npx", args, { cwd: homedir(), timeout: 60_000, maxBuffer: 1 << 20 });
  return { stdout, stderr };
};

/** Pull the frontmatter `description:` out of a `skills use` SKILL.md dump. "" if absent. */
export function parseDescription(text: string): string {
  const tagged = text.match(/<SKILL\.md>([\s\S]*?)<\/SKILL\.md>/);
  const inner = tagged ? tagged[1] : text;
  const fm = inner.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const block = fm ? fm[1] : inner;
  const line = block.match(/^description:\s*(.+?)\s*$/m);
  if (!line) return "";
  let v = line[1].trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    v = v.slice(1, -1);
  }
  return v.trim();
}

/** Best-effort one-line description for a single skill via `skills use`. "" on any failure. */
export async function describeSkill(source: string, skillId: string, opts: { run?: DescribeRun } = {}): Promise<string> {
  if (!SOURCE_RE.test(source) || !ID_RE.test(skillId) || source.includes("..") || skillId.includes("..")) return "";
  const run = opts.run ?? defaultRun;
  try {
    // Pin @latest: the `use` subcommand is newer than `add`, and an unpinned `skills`
    // can resolve to a cached older CLI that lacks it ("Unknown command: use").
    const { stdout } = await run(["-y", "skills@latest", "use", `${source}@${skillId}`]);
    return parseDescription(stdout);
  } catch {
    return "";
  }
}

/** Describe many skills concurrently (bounded). Returns a `${source}@${skillId}` → description
 *  map, omitting any that came back empty. Never throws. */
export async function describeCandidates(
  items: Array<{ source: string; skillId: string }>,
  opts: { run?: DescribeRun; concurrency?: number } = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const conc = Math.max(1, Math.min(opts.concurrency ?? 4, items.length || 1));
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const it = items[i++];
      const k = `${it.source}@${it.skillId}`;
      if (out.has(k)) continue;
      const d = await describeSkill(it.source, it.skillId, opts);
      if (d) out.set(k, d);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  return out;
}

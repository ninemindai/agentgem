// src/gem/testbedFlavors.ts
// The set of harness "flavors" a testbed can be authored/test-driven as. Flavors drive the
// flavor-specific bits — detection, scaffold skeleton, test-drive run command, and import support.
// Introspection is flavor-agnostic (introspectProject reads whatever project config is present).
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseTomlMcpServers, tomlMcpServers } from "./toml.js";
import type { McpServerArtifact } from "./types.js";
import type { resolveDirs } from "../resolveDir.js";

export type TestbedFlavorId = "claude" | "codex" | "hermes";

// The harness home roots discovery scans (the shape resolveDirs returns).
type DiscoveryDirs = ReturnType<typeof resolveDirs>;

// One project a flavor has previously been run in. `lastUsedMs` is the session
// file's mtime — a free recency signal used only to rank candidates.
export interface RawProject {
  path: string;
  lastUsedMs: number;
}

export interface FlavorImport {
  skillRel(name: string): string;
  instructionsFile: string;
  writeMcp?: (root: string, name: string, rawConfig: Record<string, unknown>) => boolean;
  supportsHooks: boolean;
}

export interface TestbedFlavor {
  id: TestbedFlavorId;
  label: string;
  detect(root: string): boolean;
  // Inverse of detect: project roots this flavor has been run in, harvested from
  // its session history. Empty when the flavor keeps no repo-scoped history.
  discoverProjects(dirs: DiscoveryDirs): RawProject[];
  scaffold(root: string, name: string): { created: string[] };
  runCommand: string;
  importSupported: boolean;
  import: FlavorImport;
}

function writeIfAbsent(root: string, rel: string, content: string, created: string[]): void {
  const abs = join(root, rel);
  if (existsSync(abs)) return;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  created.push(rel);
}

// Remove every [mcp_servers...] section (header through to the next top-level table or EOF),
// preserving all other content. Lets writeMcpCodexToml regenerate just the MCP block.
function stripMcpServerBlocks(toml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) skipping = /^\s*\[mcp_servers(\.|\])/.test(line); // a table header (re)sets the mode
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

export function writeMcpCodexToml(root: string, name: string, rawConfig: Record<string, unknown>): boolean {
  const abs = join(root, ".codex", "config.toml");
  const text = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const servers = parseTomlMcpServers(text);
  const overwritten = name in servers;
  servers[name] = rawConfig;                      // raw config — local testbed only
  const nonMcp = stripMcpServerBlocks(text).trimEnd();
  const arts = Object.entries(servers).map(([n, config]) =>
    ({ type: "mcp_server", name: n, transport: "stdio", config } as McpServerArtifact));
  const block = tomlMcpServers(arts);            // regenerated [mcp_servers...] section
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, (nonMcp ? nonMcp + "\n\n" : "") + block, "utf8");
  return overwritten;
}

function readJsonFile(abs: string): Record<string, unknown> {
  try { const v = JSON.parse(readFileSync(abs, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}

export function writeMcpJson(root: string, name: string, rawConfig: Record<string, unknown>): boolean {
  const abs = join(root, ".mcp.json");
  const doc = readJsonFile(abs);
  const servers = (doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {}) as Record<string, unknown>;
  const overwritten = name in servers;
  servers[name] = rawConfig;                       // raw config — local testbed only
  doc.mcpServers = servers;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return overwritten;
}

export const TESTBED_FLAVORS: Record<TestbedFlavorId, TestbedFlavor> = {
  claude: {
    id: "claude", label: "Claude Code", runCommand: "claude", importSupported: true,
    detect: (root) => existsSync(join(root, ".claude")) || existsSync(join(root, "CLAUDE.md")),
    // ~/.claude/projects/<path-encoded>/<uuid>.jsonl — folder name is lossy, so read
    // the real cwd out of the newest session in each folder.
    discoverProjects: (dirs) => discoverClaudeProjects(dirs.claudeDir),
    scaffold: (root, name) => {
      const created: string[] = [];
      mkdirSync(join(root, ".claude", "skills"), { recursive: true });
      writeIfAbsent(root, ".claude/settings.json", "{}\n", created);
      writeIfAbsent(root, "CLAUDE.md", `# ${name}\n`, created);
      writeIfAbsent(root, ".gitignore", ".mcp.json\n.claude/settings.json\n.env\n.targets/\n", created);
      return { created };
    },
    import: { skillRel: (n) => `.claude/skills/${n}/SKILL.md`, instructionsFile: "CLAUDE.md", writeMcp: writeMcpJson, supportsHooks: true },
  },
  codex: {
    id: "codex", label: "Codex", runCommand: "codex", importSupported: true,
    detect: (root) => existsSync(join(root, ".codex")) || existsSync(join(root, "AGENTS.md")),
    // ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — date-partitioned, so walk the
    // tree and pull payload.cwd from each session_meta header line.
    discoverProjects: (dirs) => discoverCodexProjects(dirs.codexDir),
    scaffold: (root, name) => {
      const created: string[] = [];
      mkdirSync(join(root, ".agents", "skills"), { recursive: true });
      writeIfAbsent(root, "AGENTS.md", `# ${name}\n`, created);
      writeIfAbsent(root, ".gitignore", ".codex/config.toml\n.env\n.targets/\n", created);
      return { created };
    },
    import: { skillRel: (n) => `.agents/skills/${n}/SKILL.md`, instructionsFile: "AGENTS.md", writeMcp: writeMcpCodexToml, supportsHooks: false },
  },
  hermes: {
    id: "hermes", label: "Hermes", runCommand: "hermes", importSupported: true,
    detect: (root) => existsSync(join(root, ".hermes")),
    // Hermes sessions are Slack/agent threads (~/.hermes/sessions/sessions.json),
    // not filesystem repos — there is no project cwd to harvest.
    discoverProjects: () => [],
    scaffold: (root, name) => {
      const created: string[] = [];
      mkdirSync(join(root, ".hermes", "skills"), { recursive: true });
      writeIfAbsent(root, ".hermes/SOUL.md", `# ${name}\n`, created);
      writeIfAbsent(root, ".gitignore", ".hermes/config.yaml\n.env\n.targets/\n", created);
      return { created };
    },
    import: { skillRel: (n) => `.hermes/skills/${n}/DESCRIPTION.md`, instructionsFile: ".hermes/SOUL.md", writeMcp: undefined, supportsHooks: false },
  },
};

export function flavorIds(): TestbedFlavorId[] {
  return Object.keys(TESTBED_FLAVORS) as TestbedFlavorId[];
}

// Single marker match -> that flavor; none or several -> null (caller asks).
export function detectFlavor(root: string): TestbedFlavorId | null {
  const hits = flavorIds().filter((id) => TESTBED_FLAVORS[id].detect(root));
  return hits.length === 1 ? hits[0] : null;
}

// What the startup cwd probe needs: is this folder worth offering as a testbed,
// and (if unambiguous) which flavor. flavor stays null for ambiguous/marker-less
// git repos — the UI shows an inline flavor toggle in that case.
export interface TestbedSuggestion {
  looksLikeProject: boolean;
  flavor: TestbedFlavorId | null;
}

export function suggestTestbed(root: string): TestbedSuggestion {
  const anyMarker = flavorIds().some((id) => TESTBED_FLAVORS[id].detect(root));
  const looksLikeProject = anyMarker || existsSync(join(root, ".git"));
  return { looksLikeProject, flavor: detectFlavor(root) };
}

// ── Project discovery (recent-projects candidates from session history) ──

// A previously-seen project surfaced to the picker. `lastUsed` is an ISO string
// (or null); `exists` is false for stale paths the user has since moved/deleted.
export interface ProjectCandidate {
  path: string;
  flavor: TestbedFlavorId;
  lastUsed: string | null;
  exists: boolean;
}

// Union of every flavor's discovered projects: dedup per (flavor, path) keeping
// the most recent hit, validate the path still exists, sort newest-first.
export function discoverProjects(dirs: DiscoveryDirs): ProjectCandidate[] {
  const best = new Map<string, RawProject & { flavor: TestbedFlavorId }>();
  for (const id of flavorIds()) {
    for (const proj of TESTBED_FLAVORS[id].discoverProjects(dirs)) {
      const key = `${id} ${proj.path}`;
      const prev = best.get(key);
      if (!prev || proj.lastUsedMs > prev.lastUsedMs) best.set(key, { ...proj, flavor: id });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.lastUsedMs - a.lastUsedMs)
    .map((p) => ({
      path: p.path,
      flavor: p.flavor,
      lastUsed: new Date(p.lastUsedMs).toISOString(),
      exists: existsSync(p.path),
    }));
}

// Read up to maxBytes from the front of a file. Session .jsonl files can be many
// MB; cwd lives near the top, so a bounded read avoids slurping whole transcripts.
function readHead(file: string, maxBytes = 1 << 16): string | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf8", 0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(0, nl);
}

function safeMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;

// A session file's cwd never changes, so memoize the expensive head-read+parse by
// path. Recency (statSync) stays live and uncached. Bounded by sessions on disk.
const cwdByFile = new Map<string, string | null>();
function cachedCwd(file: string, extract: (file: string) => string | null): string | null {
  const hit = cwdByFile.get(file);
  if (hit !== undefined) return hit;
  const cwd = extract(file);
  cwdByFile.set(file, cwd);
  return cwd;
}

function readClaudeCwd(file: string): string | null {
  const head = readHead(file);
  const match = head ? CWD_RE.exec(head) : null;
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`); // unescape \\ and friends
  } catch {
    return match[1];
  }
}

// Claude writes one folder per project under ~/.claude/projects, each holding
// <uuid>.jsonl sessions. We take the newest session per folder and regex its cwd
// (the first session line is sometimes a summary record with no cwd).
function discoverClaudeProjects(claudeDir: string): RawProject[] {
  const projectsDir = join(claudeDir, "projects");
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RawProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const session = newestJsonl(join(projectsDir, entry.name));
    if (!session) continue;
    const cwd = cachedCwd(session, readClaudeCwd);
    if (cwd) out.push({ path: cwd, lastUsedMs: safeMtime(session) });
  }
  return out;
}

function newestJsonl(dir: string): string | null {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = join(dir, entry.name);
    const mtimeMs = safeMtime(file);
    if (!newest || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
  }
  return newest?.file ?? null;
}

function readCodexMetaCwd(file: string): string | null {
  const head = readHead(file);
  if (!head) return null;
  try {
    const rec = JSON.parse(firstLine(head));
    const cwd = rec?.payload?.cwd;
    return typeof cwd === "string" ? cwd : null;
  } catch {
    return null; // malformed header
  }
}

// Codex partitions sessions by date, so we walk the whole tree. Each rollout file
// opens with a {"type":"session_meta","payload":{"cwd":...}} header line.
function discoverCodexProjects(codexDir: string): RawProject[] {
  const files: string[] = [];
  walkJsonl(join(codexDir, "sessions"), files);
  const out: RawProject[] = [];
  for (const file of files) {
    const cwd = cachedCwd(file, readCodexMetaCwd);
    if (cwd) out.push({ path: cwd, lastUsedMs: safeMtime(file) });
  }
  return out;
}

function walkJsonl(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(p, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(p);
  }
}

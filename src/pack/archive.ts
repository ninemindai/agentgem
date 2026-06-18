import { createHash } from "node:crypto";
import type { FileTree, SkippedArtifact } from "./targets.js";
import type {
  Pack, PackArtifact, ArtifactType,
  SkillArtifact, McpServerArtifact, HookArtifact, PackCheck,
} from "./types.js";
import { safePathSegment } from "./targets.js";

export type { FileTree, SkippedArtifact };
export const ARCHIVE_FORMAT_VERSION = 1;

const MANIFEST_PATH = "pack.json";
const LOCK_PATH = "pack.lock";

export interface PackLock {
  formatVersion: number;
  files: Record<string, string>; // path -> "sha256:<hex>"
  packDigest: string;            // "sha256:<hex>"
  signature: string | null;
}

export interface VerifyResult { ok: boolean; mismatches: string[]; missing: string[]; extra: string[] }

function sha256(s: string): string {
  return "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");
}

// Deterministic JSON: object keys sorted recursively, arrays keep order.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function fileHash(p: string, content: string): string {
  if (p === MANIFEST_PATH) return sha256(stableStringify(JSON.parse(content)));
  return sha256(content);
}

export function computeLock(files: FileTree): PackLock {
  const paths = Object.keys(files).filter((p) => p !== LOCK_PATH).sort();
  const fileDigests: Record<string, string> = {};
  const manifestCanonical = MANIFEST_PATH in files ? stableStringify(JSON.parse(files[MANIFEST_PATH])) : "";
  for (const p of paths) {
    fileDigests[p] = fileHash(p, files[p]);
  }
  const fileLines = paths.map((p) => `${p}:${fileDigests[p]}`).join("\n");
  const packDigest = sha256(manifestCanonical + "\n" + fileLines);
  return { formatVersion: ARCHIVE_FORMAT_VERSION, files: fileDigests, packDigest, signature: null };
}

export function verifyLock(files: FileTree, lock: PackLock): VerifyResult {
  const present = Object.keys(files).filter((p) => p !== LOCK_PATH);
  const mismatches: string[] = [];
  for (const p of present) if (p in lock.files && fileHash(p, files[p]) !== lock.files[p]) mismatches.push(p);
  const missing = Object.keys(lock.files).filter((p) => !(p in files));
  const extra = present.filter((p) => !(p in lock.files));
  let ok = mismatches.length === 0 && missing.length === 0 && extra.length === 0;
  if (ok && computeLock(files).packDigest !== lock.packDigest) { mismatches.push("packDigest"); ok = false; }
  return { ok, mismatches, missing, extra };
}

interface ManifestArtifactEntry { type: ArtifactType; name: string; path: string; description?: string; source?: string }
interface ManifestCheckEntry { name: string; path: string }
interface PackManifest {
  formatVersion: number;
  name: string;
  version: string;
  createdFrom: string;
  artifacts: ManifestArtifactEntry[];
  requiredSecrets: Pack["requiredSecrets"];
  checks: ManifestCheckEntry[];
}

export interface ArchiveResult { files: FileTree; skipped: SkippedArtifact[] }

export function writePackArchive(pack: Pack, opts: { version?: string } = {}): ArchiveResult {
  const files: FileTree = {};
  const skipped: SkippedArtifact[] = [];
  const artifacts: ManifestArtifactEntry[] = [];

  const place = (path: string, content: string, name: string, type: ArtifactType): boolean => {
    if (path in files) { skipped.push({ artifact: name, type, reason: `path collision with an earlier ${type} at ${path}` }); return false; }
    files[path] = content;
    return true;
  };

  for (const a of pack.artifacts) {
    const seg = safePathSegment(a.name);
    if (a.type === "skill") {
      const path = `skills/${seg}/SKILL.md`;
      if (place(path, a.content, a.name, "skill")) {
        const e: ManifestArtifactEntry = { type: "skill", name: a.name, path, source: a.source };
        if (a.description !== undefined) e.description = a.description;
        artifacts.push(e);
      }
    } else if (a.type === "instructions") {
      const path = `instructions/${seg}.md`;
      if (place(path, a.content, a.name, "instructions")) artifacts.push({ type: "instructions", name: a.name, path });
    } else if (a.type === "mcp_server") {
      const path = `mcp/${seg}.json`;
      const body: Record<string, unknown> = { transport: a.transport, config: a.config };
      if (a.source !== undefined) body.source = a.source;
      if (a.secretRefs !== undefined) body.secretRefs = a.secretRefs;
      if (place(path, JSON.stringify(body, null, 2), a.name, "mcp_server")) artifacts.push({ type: "mcp_server", name: a.name, path });
    } else {
      const path = `hooks/${seg}.json`;
      const body: Record<string, unknown> = { event: a.event, config: a.config };
      if (a.matcher !== undefined) body.matcher = a.matcher;
      if (a.source !== undefined) body.source = a.source;
      if (a.secretRefs !== undefined) body.secretRefs = a.secretRefs;
      if (place(path, JSON.stringify(body, null, 2), a.name, "hook")) artifacts.push({ type: "hook", name: a.name, path });
    }
  }

  const checks: ManifestCheckEntry[] = [];
  for (const c of pack.checks) {
    const path = `checks/${safePathSegment(c.name)}.json`;
    if (path in files) continue; // check names are unique within a pack; never overwrite a body
    files[path] = JSON.stringify(c, null, 2);
    checks.push({ name: c.name, path });
  }

  const manifest: PackManifest = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    name: pack.name,
    version: opts.version ?? "0.1.0",
    createdFrom: pack.createdFrom,
    artifacts,
    requiredSecrets: pack.requiredSecrets,
    checks,
  };
  files[MANIFEST_PATH] = JSON.stringify(manifest, null, 2);
  files[LOCK_PATH] = JSON.stringify(computeLock(files), null, 2);
  return { files, skipped };
}

export function readPackArchive(files: FileTree): Pack {
  const manifestRaw = files[MANIFEST_PATH];
  if (manifestRaw === undefined) throw new Error("archive missing pack.json");
  const lockRaw = files[LOCK_PATH];
  if (lockRaw === undefined) throw new Error("archive missing pack.lock");

  const manifest = JSON.parse(manifestRaw) as PackManifest;
  const lock = JSON.parse(lockRaw) as PackLock;
  const v = verifyLock(files, lock);
  if (!v.ok) {
    throw new Error(
      `pack.lock verification failed — mismatches:[${v.mismatches.join(",")}] missing:[${v.missing.join(",")}] extra:[${v.extra.join(",")}]`,
    );
  }

  const body = (path: string): string => {
    const c = files[path];
    if (c === undefined) throw new Error(`manifest references missing file ${path}`);
    return c;
  };

  const artifacts: PackArtifact[] = manifest.artifacts.map((e): PackArtifact => {
    if (e.type === "skill") {
      const a: SkillArtifact = { type: "skill", name: e.name, source: e.source ?? "standalone", content: body(e.path) };
      if (e.description !== undefined) a.description = e.description;
      return a;
    }
    if (e.type === "instructions") {
      return { type: "instructions", name: e.name, content: body(e.path) };
    }
    if (e.type === "mcp_server") {
      const o = JSON.parse(body(e.path)) as { transport: McpServerArtifact["transport"]; config: Record<string, unknown>; source?: string; secretRefs?: McpServerArtifact["secretRefs"] };
      const a: McpServerArtifact = { type: "mcp_server", name: e.name, transport: o.transport, config: o.config };
      if (o.source !== undefined) a.source = o.source;
      if (o.secretRefs !== undefined) a.secretRefs = o.secretRefs;
      return a;
    }
    const o = JSON.parse(body(e.path)) as { event: string; matcher?: string; config: Record<string, unknown>; source?: string; secretRefs?: HookArtifact["secretRefs"] };
    const a: HookArtifact = { type: "hook", name: e.name, event: o.event, config: o.config };
    if (o.matcher !== undefined) a.matcher = o.matcher;
    if (o.source !== undefined) a.source = o.source;
    if (o.secretRefs !== undefined) a.secretRefs = o.secretRefs;
    return a;
  });

  const checks: PackCheck[] = manifest.checks.map((c) => JSON.parse(body(c.path)) as PackCheck);
  return { name: manifest.name, createdFrom: manifest.createdFrom, artifacts, checks, requiredSecrets: manifest.requiredSecrets };
}

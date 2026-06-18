import { createHash } from "node:crypto";
import type { FileTree, SkippedArtifact } from "./targets.js";

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

export function computeLock(files: FileTree): PackLock {
  const paths = Object.keys(files).filter((p) => p !== LOCK_PATH).sort();
  const fileDigests: Record<string, string> = {};
  const manifestCanonical = MANIFEST_PATH in files ? stableStringify(JSON.parse(files[MANIFEST_PATH])) : "";
  for (const p of paths) {
    if (p === MANIFEST_PATH) {
      fileDigests[p] = sha256(manifestCanonical);
    } else {
      fileDigests[p] = sha256(files[p]);
    }
  }
  const fileLines = paths.map((p) => `${p}:${fileDigests[p]}`).join("\n");
  const packDigest = sha256(manifestCanonical + "\n" + fileLines);
  return { formatVersion: ARCHIVE_FORMAT_VERSION, files: fileDigests, packDigest, signature: null };
}

export function verifyLock(files: FileTree, lock: PackLock): VerifyResult {
  const present = Object.keys(files).filter((p) => p !== LOCK_PATH);
  const mismatches: string[] = [];
  for (const p of present) if (p in lock.files && sha256(files[p]) !== lock.files[p]) mismatches.push(p);
  const missing = Object.keys(lock.files).filter((p) => !(p in files));
  const extra = present.filter((p) => !(p in lock.files));
  let ok = mismatches.length === 0 && missing.length === 0 && extra.length === 0;
  if (ok && computeLock(files).packDigest !== lock.packDigest) { mismatches.push("packDigest"); ok = false; }
  return { ok, mismatches, missing, extra };
}

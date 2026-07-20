// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Author-supplied uploads for a seeded miniapp. Reference files inform the build only (gitignored ref/);
// ship files are inlined into the single-file miniapp, so they are capped small (the save gate rejects
// bundles > 1.5MB) and manifested with ready-to-use data: URIs. The studio agent is cwd-jailed to `dir`.
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type UploadRole = "ship" | "reference";
export interface UploadFile { name: string; bytesBase64: string; type?: string; role: UploadRole }
export interface UploadCounts { ship: number; ref: number }
export interface StoredUpload { requested: string; stored: string; role: UploadRole }
export interface UploadResult { files: StoredUpload[]; ship: number; ref: number }

const MAX_FILES = 20;
const SHIP_MAX_FILE = 500_000, SHIP_MAX_TOTAL = 1_000_000;
const REF_MAX_FILE = 5_000_000, REF_MAX_TOTAL = 15_000_000;

// A shipped miniapp is one self-contained HTML: binaries must inline as data: URIs, text the agent reads
// raw. SVG is text. Unknown/empty type is treated as binary (the safe default — it still gets a URI).
const TEXT_TYPES = /^(text\/|application\/json$|image\/svg\+xml$)/i;
function isBinary(type: string | undefined): boolean {
  return !type || !TEXT_TYPES.test(type);
}

// A well-formed MIME token — anything else can't be trusted inside a data: URI, fall back to octet-stream.
function safeMime(type: string | undefined): string {
  return type && /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/.test(type) ? type : "application/octet-stream";
}

// Fold to a single safe path segment, preserving one extension. Reject path separators outright (no
// silent basename-folding of traversal attempts like "../../etc/passwd") and reject dotfiles (".git").
// Mirrors studio.ts slugify but keeps the extension.
export function sanitizeUploadName(raw: string): string {
  if (!raw || raw === "." || raw === ".." || /[\\/]/.test(raw) || raw.startsWith(".")) {
    throw new Error(`unsafe upload filename: '${raw}'`);
  }
  const dot = raw.lastIndexOf(".");
  const stem = (dot > 0 ? raw.slice(0, dot) : raw).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  const ext = (dot > 0 ? raw.slice(dot + 1) : "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!stem) throw new Error(`unsafe upload filename: '${raw}'`);
  return ext ? `${stem}.${ext}` : stem;
}

function decode(f: UploadFile): Buffer {
  // Node's base64 decoder is lenient; round-trip to detect junk so we fail loudly, not silently truncate.
  const buf = Buffer.from(f.bytesBase64, "base64");
  if (buf.toString("base64").replace(/=+$/, "") !== f.bytesBase64.replace(/\s|=+$/g, "")) {
    throw new Error(`invalid base64 for upload '${f.name}'`);
  }
  return buf;
}

interface AssetEntry { file: string; type: string; bytes: number; dataUri?: string }

export function writeUploads(dir: string, files: UploadFile[]): UploadResult {
  // Preload existing workspace state so repeat batches accumulate instead of clobbering.
  const usedShip = new Set<string>(), usedRef = new Set<string>();
  const manifest: AssetEntry[] = [];
  let shipTotal = 0, refTotal = 0;
  const uploadsDir = join(dir, "uploads"), refDir = join(dir, "ref");
  if (existsSync(uploadsDir)) for (const f of readdirSync(uploadsDir)) if (f !== "assets.json") usedShip.add(f);
  if (existsSync(refDir)) for (const f of readdirSync(refDir)) { usedRef.add(f); refTotal += statSync(join(refDir, f)).size; }
  const assetsPath = join(uploadsDir, "assets.json");
  if (existsSync(assetsPath)) {
    const prev = JSON.parse(readFileSync(assetsPath, "utf8")) as AssetEntry[];
    for (const e of prev) { manifest.push(e); shipTotal += e.bytes; }
  }

  const cumulativeCounts = (): { ship: number; ref: number } => ({ ship: usedShip.size, ref: usedRef.size });
  if (!files.length) return { files: [], ...cumulativeCounts() };
  if (files.length > MAX_FILES) throw new Error(`too many files: ${files.length} > ${MAX_FILES}`);

  // Collisions are per-DIRECTORY: a ship file and a reference file may share a name (they land in
  // uploads/ vs ref/), so each dir keeps its own Set — only same-dir same-name files get suffixed.
  const uniq = (name: string, used: Set<string>): string => {
    if (!used.has(name)) { used.add(name); return name; }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 2; ; i++) { const c = `${stem}-${i}${ext}`; if (!used.has(c)) { used.add(c); return c; } }
  };

  // Pass A — decode + validate + PLAN stored names. No writes: any throw here leaves the dir untouched.
  const planned = files.map((f) => {
    const buf = decode(f);
    if (f.role === "ship") {
      if (buf.length > SHIP_MAX_FILE) throw new Error(`ship file '${f.name}' is ${buf.length} bytes > ${SHIP_MAX_FILE}`);
      shipTotal += buf.length;
    } else {
      if (buf.length > REF_MAX_FILE) throw new Error(`reference file '${f.name}' is ${buf.length} bytes > ${REF_MAX_FILE}`);
      refTotal += buf.length;
    }
    const stored = uniq(sanitizeUploadName(f.name), f.role === "ship" ? usedShip : usedRef); // sanitize can throw → still no writes
    return { f, buf, stored };
  });
  if (shipTotal > SHIP_MAX_TOTAL) throw new Error(`ship total ${shipTotal} > ${SHIP_MAX_TOTAL}`);
  if (refTotal > REF_MAX_TOTAL) throw new Error(`reference total ${refTotal} > ${REF_MAX_TOTAL}`);

  // Pass B — write. All names are pre-planned, so this only does I/O.
  const records: StoredUpload[] = [];
  for (const { f, buf, stored } of planned) {
    if (f.role === "ship") {
      mkdirSync(uploadsDir, { recursive: true });
      writeFileSync(join(uploadsDir, stored), buf);
      const type = safeMime(f.type);
      const entry: AssetEntry = { file: `uploads/${stored}`, type, bytes: buf.length };
      if (isBinary(f.type)) entry.dataUri = `data:${type};base64,${buf.toString("base64")}`;
      manifest.push(entry);
    } else {
      mkdirSync(refDir, { recursive: true });
      writeFileSync(join(refDir, stored), buf);
    }
    records.push({ requested: f.name, stored, role: f.role });
  }

  if (manifest.length) writeFileSync(assetsPath, JSON.stringify(manifest, null, 2));
  // Per-miniapp .gitignore keeps reference material out of the registry repo (never committed/pushed).
  // Written in `dir` (freshly claimed), so it's atomic and needs no root backfill; `/*/ref/`-style root
  // rules were avoided because a miniapp legitimately named "ref" would otherwise be swallowed.
  if (records.some((r) => r.role === "reference")) {
    const gi = join(dir, ".gitignore");
    const line = "ref/\n";
    const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    if (!/(^|\n)ref\/(\n|$)/.test(cur)) writeFileSync(gi, cur && !cur.endsWith("\n") ? cur + "\n" + line : cur + line);
  }
  return { files: records, ...cumulativeCounts() };
}

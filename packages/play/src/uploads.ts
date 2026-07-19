// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Author-supplied uploads for a seeded miniapp. Reference files inform the build only (gitignored ref/);
// ship files are inlined into the single-file miniapp, so they are capped small (the save gate rejects
// bundles > 1.5MB) and manifested with ready-to-use data: URIs. The studio agent is cwd-jailed to `dir`.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type UploadRole = "ship" | "reference";
export interface UploadFile { name: string; bytesBase64: string; type?: string; role: UploadRole }
export interface UploadCounts { ship: number; ref: number }

const MAX_FILES = 20;
const SHIP_MAX_FILE = 500_000, SHIP_MAX_TOTAL = 1_000_000;
const REF_MAX_FILE = 5_000_000, REF_MAX_TOTAL = 15_000_000;

// A shipped miniapp is one self-contained HTML: binaries must inline as data: URIs, text the agent reads
// raw. SVG is text. Unknown/empty type is treated as binary (the safe default — it still gets a URI).
const TEXT_TYPES = /^(text\/|application\/json$|image\/svg\+xml$)/i;
function isBinary(type: string | undefined): boolean {
  return !type || !TEXT_TYPES.test(type);
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

export function writeUploads(dir: string, files: UploadFile[]): UploadCounts {
  if (!files.length) return { ship: 0, ref: 0 };
  if (files.length > MAX_FILES) throw new Error(`too many files: ${files.length} > ${MAX_FILES}`);

  const decoded = files.map((f) => ({ f, buf: decode(f), name: sanitizeUploadName(f.name) }));

  let shipTotal = 0, refTotal = 0;
  for (const { f, buf } of decoded) {
    if (f.role === "ship") {
      if (buf.length > SHIP_MAX_FILE) throw new Error(`ship file '${f.name}' is ${buf.length} bytes > ${SHIP_MAX_FILE}`);
      shipTotal += buf.length;
    } else {
      if (buf.length > REF_MAX_FILE) throw new Error(`reference file '${f.name}' is ${buf.length} bytes > ${REF_MAX_FILE}`);
      refTotal += buf.length;
    }
  }
  if (shipTotal > SHIP_MAX_TOTAL) throw new Error(`ship total ${shipTotal} > ${SHIP_MAX_TOTAL}`);
  if (refTotal > REF_MAX_TOTAL) throw new Error(`reference total ${refTotal} > ${REF_MAX_TOTAL}`);

  const used = new Set<string>();
  const uniq = (name: string): string => {
    if (!used.has(name)) { used.add(name); return name; }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 2; ; i++) { const c = `${stem}-${i}${ext}`; if (!used.has(c)) { used.add(c); return c; } }
  };

  const manifest: AssetEntry[] = [];
  let ship = 0, ref = 0;
  for (const { f, buf } of decoded) {
    const name = uniq(sanitizeUploadName(f.name));
    if (f.role === "ship") {
      mkdirSync(join(dir, "uploads"), { recursive: true });
      writeFileSync(join(dir, "uploads", name), buf);
      const type = f.type || "application/octet-stream";
      const entry: AssetEntry = { file: `uploads/${name}`, type, bytes: buf.length };
      if (isBinary(f.type)) entry.dataUri = `data:${type};base64,${buf.toString("base64")}`;
      manifest.push(entry);
      ship++;
    } else {
      mkdirSync(join(dir, "ref"), { recursive: true });
      writeFileSync(join(dir, "ref", name), buf);
      ref++;
    }
  }

  if (manifest.length) {
    writeFileSync(join(dir, "uploads", "assets.json"), JSON.stringify(manifest, null, 2));
  }
  // Per-miniapp .gitignore keeps reference material out of the registry repo (never committed/pushed).
  // Written in `dir` (freshly claimed), so it's atomic and needs no root backfill; `/*/ref/`-style root
  // rules were avoided because a miniapp legitimately named "ref" would otherwise be swallowed.
  if (ref) {
    const gi = join(dir, ".gitignore");
    const line = "ref/\n";
    const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    if (!/(^|\n)ref\/(\n|$)/.test(cur)) writeFileSync(gi, cur + line);
  }
  return { ship, ref };
}

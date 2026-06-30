// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/share.ts
// The registry-optional "easy share" loop: turn a Gem into one portable .gem file
// and install one back. Pure + in-process — no disk/network — so it composes with
// any transport (file, URL, gist, paste). Integrity is inherited from readGemArchive,
// which verifies gem.lock and throws on any mismatch, so a tampered .gem never installs.
import { writeGemArchive, readGemArchive, readGemMeta } from "@agentgem/archive";
import { packTar, unpackTar } from "@agentgem/archive";
import { safePathSegment } from "@agentgem/model";
import type { Gem } from "@agentgem/model";

export interface ExportedGem { filename: string; bytes: Buffer; skipped: ReturnType<typeof writeGemArchive>["skipped"] }
export interface ImportedGem { gem: Gem; meta: ReturnType<typeof readGemMeta> }

// Gem -> a single self-verifying .gem (gzipped tar of the archive file tree).
export function exportGem(gem: Gem, opts: { version?: string; dependencies?: string[] } = {}): ExportedGem {
  const { files, skipped } = writeGemArchive(gem, opts);
  const version = opts.version ?? "0.1.0";
  return { filename: `${safePathSegment(gem.name)}-${version}.gem`, bytes: packTar(files), skipped };
}

// A .gem's bytes -> the verified Gem. Throws if the bytes aren't a valid archive
// or if gem.lock verification fails (tampering / corruption).
export function importGem(bytes: Buffer): ImportedGem {
  const files = unpackTar(bytes);
  const gem = readGemArchive(files); // verifies gem.lock; throws on mismatch
  return { gem, meta: readGemMeta(files) };
}

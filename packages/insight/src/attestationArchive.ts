// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/attestationArchive.ts
import type { Gem } from "@agentgem/model";
import type { FileTree } from "@agentgem/archive";
import { writeGemArchive, computeLock } from "@agentgem/archive";
import { canonicalJSON, type UsageAttestation } from "./attestation.js";
import type { Identity } from "@agentgem/model";

export function writeAttestedArchive(
  gem: Gem, attestation: UsageAttestation, identity: Identity,
  opts: { version?: string; dependencies?: string[] } = {},
): { files: FileTree } {
  const { files } = writeGemArchive(gem, opts);
  // Inject attestation.json. computeLock excludes gem.lock from its hashed set,
  // so passing withAtt (which still contains the old gem.lock) is safe — it will
  // not be hashed, and attestation.json will be fully covered by the new lock.
  const withAtt: FileTree = { ...files, "attestation.json": canonicalJSON(attestation) };
  const lock = computeLock(withAtt);
  lock.signature = identity.sign(lock.gemDigest);
  withAtt["gem.lock"] = JSON.stringify(lock);
  return { files: withAtt };
}

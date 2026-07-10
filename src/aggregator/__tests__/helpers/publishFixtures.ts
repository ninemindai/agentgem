// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Shared fixtures for the installable-shared-setups tests: an ed25519 signer, a four-kind sample
// setup gem, and a signed /publish-gem body built from it.
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { exportGem, importGem } from "@agentgem/distribute";
import { catalogSigningPayload } from "@agentgem/aggregator";
import type { CatalogManifest } from "@agentgem/aggregator";
import type { Gem } from "@agentgem/model";

export function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { pubkey, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

// A four-kind setup gem: skill + instructions + mcp_server (executable) + hook (executable).
export function sampleGem(): Gem {
  return {
    name: "my-setup", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
    artifacts: [
      { type: "skill", name: "brainstorm", source: "standalone", content: "# Brainstorm\n" },
      { type: "instructions", name: "guide", content: "guidance" },
      { type: "mcp_server", name: "gh", transport: "stdio", config: { command: "gh-mcp" } },
      { type: "hook", name: "fmt", event: "PostToolUse", config: { command: "prettier" } },
    ],
  };
}

// Build the archive + a signed /publish-gem request body for a gem.
export function signedPublishBody(gem: Gem, s: ReturnType<typeof signer>, opts: { gemKey: string; version: string; signedAt: number }) {
  const { bytes } = exportGem(gem, { version: opts.version });
  const { meta } = importGem(bytes);
  const manifest: CatalogManifest = {
    gemKey: opts.gemKey, version: opts.version,
    artifacts: gem.artifacts.map((a) => ({ name: a.name, type: a.type })),
    artifactKinds: [...new Set(gem.artifacts.map((a) => a.type))],
    gemDigest: meta.gemDigest,
  };
  const signature = s.sign(catalogSigningPayload(manifest, s.pubkey, opts.signedAt));
  return { manifest, archiveBase64: bytes.toString("base64"), pubkey: s.pubkey, signedAt: opts.signedAt, signature, bytes, gemDigest: meta.gemDigest };
}

// A one-artifact game gem, for the share-archive (miniapp) path.
export function gameGem(): import("@agentgem/model").Gem {
  return {
    name: "tetris", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
    artifacts: [{
      type: "game", name: "tetris", title: "Tetris", genre: "project-fun",
      html: "<!doctype html><title>t</title><canvas></canvas>", createdFrom: { kind: "blank", title: "Tetris" }, engineVersion: "1",
    }],
  } as import("@agentgem/model").Gem;
}

// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Connector-identity digest for consent pinning (spec D3/D7). Over the REDACTED config, so it is:
//   • STABLE across a secret rotation (redactMcpConfig blanks the value; the env var NAME survives) —
//     a new GITHUB_TOKEN must not silently wipe the viewer's consent.
//   • CHANGED when the implementation swaps (command/args/url) or the declared secret surface changes —
//     the D9 shadowing threat: install a different gem under the same name and the digest moves.
// It is config pinning, NOT binary-identity pinning: a same-config repoint of the underlying binary
// (symlink / docker tag) is not detected — that needs local write access, which is already full
// compromise of the trusted local surface. Deterministic canonical JSON (sorted keys) or consent churns.
import { createHash } from "node:crypto";
import { redactMcpConfig } from "@agentgem/base";
import type { McpServerArtifact } from "@agentgem/model";

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function mcpServerConfigDigest(gem: McpServerArtifact): string {
  const { config } = redactMcpConfig(gem.config);
  const payload = canonical({ transport: gem.transport, config });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

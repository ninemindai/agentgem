// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import type { GemArtifact, McpServerArtifact, ReferenceArtifact } from "./types.js";

/** Resolve a by-reference artifact into a concrete one for materialization.
 *  package → reconstructed McpServerArtifact (stays a reference: an npx command, no bytes inlined).
 *  gem     → not yet resolved (registry fetch/merge is a follow-on); reported, never thrown. */
export function resolveArtifactRef(a: ReferenceArtifact):
  | { ok: true; artifact: GemArtifact }
  | { ok: false; reason: string } {
  if (!a?.ref || typeof a.ref.id !== "string") return { ok: false, reason: "malformed reference (missing ref or id)" };
  if (a.ref.kind === "package") {
    // id shape "npx:@scope/pkg" or "runner:pkg" -> { command: runner, args: [pkg] }
    const [runner, ...rest] = a.ref.id.split(":");
    const pkg = rest.join(":");
    if (!runner || !pkg) return { ok: false, reason: `malformed package ref id '${a.ref.id}'` };
    const mcp: McpServerArtifact = { type: "mcp_server", name: a.name, transport: "stdio", config: { command: runner, args: [pkg] } };
    return { ok: true, artifact: mcp };
  }
  return { ok: false, reason: "gem reference resolution is not implemented yet" };
}

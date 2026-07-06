// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Server-side validation gate. Tier-1: static "self-contained" checks that keep a game bundle
// sealed and shareable (no network, no external assets), independent of any agent self-report.

export interface GateResult { ok: boolean; failures: string[] }
export interface GateOptions {
  maxBytes?: number;                 // default 1.5 MB — archives/shares well
  allowedNeeds?: readonly string[];  // recognized capability names (for the needs sanity check)
}

const DEFAULT_MAX_BYTES = 1_500_000;

// External-resource patterns. `data:` is allowed (self-contained); http(s)/protocol-relative are not.
const EXTERNAL_ATTR = /\b(?:src|href)\s*=\s*["'](?!data:|#)(?:https?:)?\/\//i;
const BARE_IMPORT = /\bimport\s+[^;]*?from\s+["'](?!data:)[^"']+["']/;
const NETWORK_CALL = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|navigator\.sendBeacon)\b/;

export function staticGate(html: string, opts: GateOptions = {}): GateResult {
  const failures: string[] = [];
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  if (Buffer.byteLength(html, "utf8") > maxBytes) {
    failures.push(`bundle exceeds size budget (${maxBytes} bytes)`);
  }
  if (EXTERNAL_ATTR.test(html)) {
    failures.push("references an external resource (src/href to a remote URL)");
  }
  if (BARE_IMPORT.test(html)) {
    failures.push("uses an external module import");
  }
  if (NETWORK_CALL.test(html)) {
    failures.push("attempts a network call (fetch/XHR/WebSocket/…) — games must be sealed");
  }

  return { ok: failures.length === 0, failures };
}

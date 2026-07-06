// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Server-side validation gate. Tier-1: static "self-contained" checks that keep a game bundle
// sealed and shareable (no network, no external assets), independent of any agent self-report,
// plus a jsdom load-smoke that catches uncaught throws on load.
import { JSDOM, VirtualConsole } from "jsdom";

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

// Tier-1 continued: a load-smoke. Execute the bundle's inline scripts in a jsdom DOM (no network:
// resources are not fetched) and catch an uncaught throw in the first tick. jsdom cannot see a blank
// canvas — visual correctness is the human preview's job (Tier-2) — but it reliably catches the large
// class of "broken on load" failures the self-repair loop iterates against.
export async function gameGate(html: string, opts: GateOptions = {}): Promise<GateResult> {
  const staticResult = staticGate(html, opts);
  if (!staticResult.ok) return staticResult; // short-circuit; don't execute a non-sealed bundle

  const failures: string[] = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (err: Error) => failures.push(`inline script threw: ${err.message}`));

  try {
    const dom = new JSDOM(html, {
      runScripts: "dangerously", // execute inline <script>; jsdom does NOT fetch external resources
      virtualConsole: vc,
      pretendToBeVisual: true,   // provides requestAnimationFrame so canvas game loops don't throw
    });
    await new Promise((r) => setTimeout(r, 0)); // let the first tick run
    dom.window.close();
  } catch (err) {
    failures.push(`bundle failed to load: ${(err as Error).message}`);
  }

  return { ok: failures.length === 0, failures };
}

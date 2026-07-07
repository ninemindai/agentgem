// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Server-side validation gate for generated game bundles. This is a best-effort ADMISSION HEURISTIC
// and the self-repair loop's error signal — NOT a security boundary. The real network seal is the
// runtime CSP sandbox (`default-src 'none'`) applied when a game is played (Plan 3); the static checks
// here only catch obvious external-reference/network *syntax*, and dynamic exfiltration (e.g.
// `new Image().src = url`) can pass them. Likewise the jsdom load-smoke runs scripts with
// `runScripts:"dangerously"`, which jsdom documents is NOT a sandbox — so gameGate() must only ever be
// called on bundles produced under our own control (the Plan 2 generator runs inside the packages/run
// sandbox). Never call it on untrusted/downloaded input in this process.
import { JSDOM, VirtualConsole } from "jsdom";

export interface GateResult { ok: boolean; failures: string[] }
export interface GateOptions {
  maxBytes?: number; // default 1.5 MB — archives/shares well
}

const DEFAULT_MAX_BYTES = 1_500_000;

// External-resource patterns. `data:` is allowed (self-contained); http(s)/protocol-relative are not.
const EXTERNAL_ATTR = /\b(?:src|href)\s*=\s*["'](?!data:|#)(?:https?:)?\/\//i;
const BARE_IMPORT = /\bimport\s+[^;]*?from\s+["'](?!data:)[^"']+["']/;
const NETWORK_CALL = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|navigator\.sendBeacon)\b/;
// Inert data payloads: <script type="application/json"> (the game-data blob) is NEVER executed by the
// browser, so words like "fetch" or https:// URLs inside baked session transcripts are content, not code.
// The syntax scans below run on the EXECUTABLE surface only (size is still measured on the full bundle).
const INERT_JSON_SCRIPT = /<script\b[^>]*\btype\s*=\s*["']application\/json["'][^>]*>[\s\S]*?<\/script>/gi;

export function staticGate(html: string, opts: GateOptions = {}): GateResult {
  const failures: string[] = [];
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const code = html.replace(INERT_JSON_SCRIPT, ""); // strip inert data before scanning for code syntax

  if (Buffer.byteLength(html, "utf8") > maxBytes) {
    failures.push(`bundle exceeds size budget (${maxBytes} bytes)`);
  }
  if (EXTERNAL_ATTR.test(code)) {
    failures.push("references an external resource (src/href to a remote URL)");
  }
  if (BARE_IMPORT.test(code)) {
    failures.push("uses an external module import");
  }
  if (NETWORK_CALL.test(code)) {
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
      // jsdom has no canvas backend, so canvas.getContext() throws by default — which would reject every
      // canvas game. Stub a no-op 2D context so canvas games load-smoke cleanly (drawing correctness is
      // the human preview's job, Tier-2; this gate only catches genuine load-time throws).
      beforeParse(window) {
        const proto = (window.HTMLCanvasElement?.prototype as unknown as Record<string, unknown> | undefined);
        if (!proto) return;
        proto.getContext = function (this: unknown) {
          return new Proxy({}, {
            get: (_t, prop) => {
              if (prop === "canvas") return this;
              if (prop === "measureText") return () => ({ width: 0 });
              if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
              if (prop === "createLinearGradient" || prop === "createRadialGradient" || prop === "createPattern")
                return () => ({ addColorStop() {} });
              return () => {};
            },
            set: () => true,
          });
        };
        proto.toDataURL = () => "data:,";
      },
    });
    await new Promise((r) => setTimeout(r, 0)); // let the first tick run
    dom.window.close();
  } catch (err) {
    failures.push(`bundle failed to load: ${(err as Error).message}`);
  }

  return { ok: failures.length === 0, failures };
}

// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// SHARED BY TWO HOSTS. This file moved out of `@agentgem/play` so AgentGem and a second host can
// run the same admission gate instead of maintaining two copies that drift. It was the natural
// thing to share because it already imported nothing from `@agentgem/*` — the extraction changed
// its address, not its dependencies.
//
// What is NOT shared is how a bundle reaches data. AgentGem seals its bundles (invariant I1: no
// network, no origin); the other confines them at runtime with a CSP `connect-src` allowlist and a
// scoped token. That difference is expressed as ONE option (`allowNetwork`), not as a fork, because
// this file's job is to produce and admit a bundle — not to decide what the bundle is allowed to
// talk to. Keep it that way: a second host-specific branch in here is the signal that something
// belongs in the host instead.
//
// Server-side validation gate for generated game bundles. This is a best-effort ADMISSION HEURISTIC
// and the self-repair loop's error signal — NOT a security boundary. The real network seal is the
// runtime CSP sandbox (`default-src 'none'`) applied when a game is played (Plan 3); the static checks
// here only catch obvious external-reference/network *syntax*, and dynamic exfiltration (e.g.
// `new Image().src = url`) can pass them. Likewise the jsdom load-smoke runs scripts with
// `runScripts:"dangerously"`, which jsdom documents is NOT a sandbox — so gameGate() must only ever be
// called on bundles produced under our own control (the Plan 2 generator runs inside the packages/run
// sandbox). Never call it on untrusted/downloaded input in this process.
// jsdom is loaded lazily inside the smoke worker (see below): it costs ~185ms to evaluate, and this
// module sits on `dist/index.js`'s import graph, which every `agentgem` CLI invocation loads. Only the
// Tier-1 load-smoke needs it. It stays a hard `dependencies` entry — the publish bundler keeps every
// root dependency external, and jsdom resolves its own `./xhr-sync-worker.js` at runtime, so inlining
// it breaks the published tarball.
//
// THE SMOKE RUNS IN A WORKER THREAD, NOT ON THE MAIN THREAD. Generated code has three ways to take the
// host down and only an isolation boundary covers all of them:
//   - an async throw escaping to `uncaughtException` (observed 2026-07-21: `new Path2D(...)` inside an
//     awaited boot() killed the app mid-Save);
//   - a synchronous spin (`while(true){}`), which blocks the event loop so NO handler runs at all —
//     there is nothing to trap, and the process cannot recover itself;
//   - unbounded allocation.
// A worker contains all three: async throws arrive on `'error'`, `terminate()` interrupts a tight loop,
// and `resourceLimits` bounds the heap. The previous implementation traded `process.removeAllListeners`
// for the first case only; that surgery is gone. In a long-lived server (the gate is called on every
// Save) the old shape meant one generated `while(true)` stopped health checks responding.
// Measured on Node 24 + jsdom 29: ~300ms warm, ~520ms cold.

export interface GateResult { ok: boolean; failures: string[] }
export interface GateOptions {
  maxBytes?: number; // default 1.5 MB — archives/shares well
  // Skip the NETWORK_CALL scan. HOST POLICY, and NOT a weakening of the gate.
  //
  // Leave it off (the default) when the host seals its bundles: the scan is then one of the four
  // things that make "sealed" checkable at admission time, and AgentGem depends on it.
  //
  // Turn it on when the host confines the bundle at RUNTIME instead — such a host serves
  // every miniapp under `default-src 'none'; connect-src <one origin>` inside a null-origin iframe, so
  // the browser enforces the single permitted destination on every request. There, scanning source
  // text for the word `fetch` would forbid the exact mechanism the host is built on while catching
  // nothing the CSP does not already stop — and `new Image().src = url` slips past the scan anyway.
  // A browser-enforced allowlist is a strictly stronger control than a regex over source.
  //
  // The other three checks (size, EXTERNAL_ATTR, BARE_IMPORT) stay on for BOTH hosts. CSP would block
  // those at runtime too, but only after the miniapp has already rendered silently broken; failing at
  // admission with a named reason is better feedback and costs nothing.
  allowNetwork?: boolean;
}

const DEFAULT_MAX_BYTES = 1_500_000;

// External-resource patterns. `data:` is allowed (self-contained); http(s)/protocol-relative are not.
const EXTERNAL_ATTR = /\b(?:src|href)\s*=\s*["'](?!data:|#)(?:https?:)?\/\//i;
const BARE_IMPORT = /\bimport\s+[^;]*?from\s+["'](?!data:)[^"']+["']/;
const NETWORK_CALL = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|navigator\.sendBeacon)\b/;
const JSON_TYPE = /\btype\s*=\s*["']application\/json["']/i;

// Return the html with the CONTENT of inert `<script type="application/json">` elements removed, so the
// syntax scans below don't false-positive on session-transcript words (a baked game-data blob naturally
// contains "fetch"/"WebSocket"/https URLs as data). We walk <script> elements the way the HTML tokenizer
// does — content runs from the tag's ">" to the next literal "</script>" — rather than a raw-text regex.
// That matters: a regex can start matching a fake `<script type="application/json">` that appears inside a
// REAL executable script's string literal and delete the executable payload with it; the tokenizer walk
// cannot, because an executable script's content only ends at a real </script>, so its code is preserved.
export function scannableCode(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const open = lower.indexOf("<script", i);
    if (open === -1) { out += html.slice(i); break; }
    const gt = html.indexOf(">", open);
    if (gt === -1) { out += html.slice(i); break; } // malformed open tag → keep the rest, scan it
    const close = lower.indexOf("</script>", gt);
    const contentEnd = close === -1 ? html.length : close;
    const elemEnd = close === -1 ? html.length : close + "</script>".length;
    out += html.slice(i, gt + 1); // everything up to & including the <script …> open tag (keeps src= attrs)
    if (!JSON_TYPE.test(html.slice(open, gt + 1))) out += html.slice(gt + 1, contentEnd); // keep executable body
    out += html.slice(contentEnd, elemEnd); // the </script>
    i = elemEnd;
  }
  return out;
}

export function staticGate(html: string, opts: GateOptions = {}): GateResult {
  const failures: string[] = [];
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const code = scannableCode(html); // drop inert data content before scanning for code syntax

  if (Buffer.byteLength(html, "utf8") > maxBytes) {
    failures.push(`bundle exceeds size budget (${maxBytes} bytes)`);
  }
  if (EXTERNAL_ATTR.test(code)) {
    failures.push("references an external resource (src/href to a remote URL)");
  }
  if (BARE_IMPORT.test(code)) {
    failures.push("uses an external module import");
  }
  if (!opts.allowNetwork && NETWORK_CALL.test(code)) {
    failures.push("attempts a network call (fetch/XHR/WebSocket/…) — games must be sealed");
  }

  return { ok: failures.length === 0, failures };
}

// Wall-clock ceiling for the smoke. A synchronous spin never yields, so this is the ONLY thing that
// ends it. Generous enough that a slow cold jsdom evaluate (~520ms) is nowhere near it.
const SMOKE_TIMEOUT_MS = 5_000;

// Heap ceiling for the worker. A 1.5 MB bundle plus jsdom sits far under this; unbounded allocation
// trips it and V8 kills the thread instead of the host.
const SMOKE_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 };

// The worker body, as source text run with `{ eval: true }` — deliberately NOT a sibling .ts file.
//
// Reassess this if the packaging changes; the reason is no longer the obvious one. As a published
// package with `files: ["dist"]`, THIS package could ship a sibling `smokeWorker.js` just fine, and
// an npm consumer resolving it via `new Worker(new URL("./smokeWorker.js", import.meta.url))` would
// work. The constraint comes from the OTHER consumer: AgentGem keeps this package a root
// devDependency so `scripts/bundle-bins.mjs` compiles it INTO the CLI entrypoints, and that inlining
// rewrites `import.meta.url` (the same mechanism behind the `client.js` double-boot guard documented
// there). In that build the sibling path resolves to a file that does not exist.
//
// So the inline string is what lets ONE implementation serve both consumers. If AgentGem ever moves
// this package to a real `dependencies` entry (external, not inlined), the constraint disappears and
// a typed sibling file becomes the better shape.
//
// Cost: this string is not typechecked, so keep it small and change it deliberately —
// `gameGate.worker.test.ts` covers its behavior.
//
// jsdom is resolved by the PARENT (`require.resolve`) and passed in, because an eval'd worker has no
// meaningful path of its own to resolve from.
const SMOKE_WORKER_SRC = `
const { workerData, parentPort } = require("node:worker_threads");
(async () => {
  const failures = [];
  const msg = (e) => (e && e.message) ? e.message : String(e);

  // Record async escapes IN THE WORKER rather than relying on Node turning an unhandled rejection
  // into the parent's 'error' event. That default is policy, not a guarantee: under
  // \`--unhandled-rejections=warn\` (settable via NODE_OPTIONS by whoever runs us) the rejection only
  // warns, the worker then posts ok:true, and a bundle whose async boot() throws gets ADMITTED. A
  // false pass is worse than the crash this whole file exists to prevent — the broken miniapp ships.
  //
  // This is the trap the pre-worker implementation used, moved to where it is safe. Mutating process
  // listeners was only ever hazardous because it happened on a shared host; inside the worker these
  // globals are ours alone, so there is nothing to clobber and nothing to restore.
  process.on("unhandledRejection", (err) => failures.push("inline script crashed asynchronously: " + msg(err)));
  process.on("uncaughtException", (err) => failures.push("inline script crashed asynchronously: " + msg(err)));

  try {
    const { JSDOM, VirtualConsole } = await import(workerData.jsdomHref);
    const vc = new VirtualConsole();
    vc.on("jsdomError", (err) => failures.push("inline script threw: " + err.message));
    const dom = new JSDOM(workerData.html, {
      runScripts: "dangerously", // execute inline <script>; jsdom does NOT fetch external resources
      virtualConsole: vc,
      pretendToBeVisual: true,   // provides requestAnimationFrame so canvas game loops don't throw
      // jsdom has no canvas backend, so canvas.getContext() throws by default — which would reject
      // every canvas game. Stub a no-op 2D context so canvas games load-smoke cleanly (drawing
      // correctness is the human preview's job, Tier-2; this gate only catches genuine load throws).
      beforeParse(window) {
        // Canvas API surface jsdom lacks BEYOND getContext. No-op stand-ins keep the smoke about
        // genuine load failures, not about jsdom's missing canvas backend. Guarded assignments — if
        // jsdom grows real ones, they win.
        const w = window;
        if (!w.Path2D) w.Path2D = class { addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {} rect() {} roundRect() {} closePath() {} };
        if (!w.DOMMatrix) w.DOMMatrix = class { multiply() { return this; } translate() { return this; } scale() { return this; } rotate() { return this; } invertSelf() { return this; } };
        if (!w.ImageData) w.ImageData = class { data = new Uint8ClampedArray(4); width = 1; height = 1; };
        if (!w.OffscreenCanvas) w.OffscreenCanvas = class { getContext() { return null; } };
        if (!w.createImageBitmap) w.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
        const proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
        if (!proto) return;
        proto.getContext = function () {
          const canvas = this;
          return new Proxy({}, {
            get: (_t, prop) => {
              if (prop === "canvas") return canvas;
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
    await new Promise((r) => setTimeout(r, 0)); // and the microtask backlog behind it (async boot())
    dom.window.close();
  } catch (err) {
    failures.push("bundle failed to load: " + (err && err.message ? err.message : String(err)));
  }
  parentPort.postMessage({ ok: failures.length === 0, failures });
})();
`;

// Tier-1 continued: a load-smoke. Execute the bundle's inline scripts in a jsdom DOM (no network:
// resources are not fetched) and catch an uncaught throw in the first tick. jsdom cannot see a blank
// canvas — visual correctness is the human preview's job (Tier-2) — but it reliably catches the large
// class of "broken on load" failures the self-repair loop iterates against.
export async function gameGate(html: string, opts: GateOptions = {}): Promise<GateResult> {
  const staticResult = staticGate(html, opts);
  if (!staticResult.ok) return staticResult; // short-circuit; don't execute a non-sealed bundle

  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  // gameGate RESOLVES; it does not reject. saveMiniapp (miniapps.ts:127) awaits it with no try/catch
  // and formats `gate.failures` on the next line, so a thrown setup error would surface there as a
  // raw stack instead of an actionable gate message. Everything that can throw before the smoke
  // starts — the dynamic imports, resolving jsdom, and constructing the Worker (which throws on
  // thread-creation failure) — converts to a failure here.
  let Worker: typeof import("node:worker_threads").Worker;
  let jsdomHref: string;
  try {
    ({ Worker } = await import("node:worker_threads"));
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    jsdomHref = pathToFileURL(createRequire(import.meta.url).resolve("jsdom")).href;
  } catch (err) {
    return { ok: false, failures: [`smoke could not start: ${errText(err)}`] };
  }

  return await new Promise<GateResult>((resolve) => {
    // FOUR settle paths, and all four are load-bearing:
    //   'message' — the smoke finished and reported (including async escapes the worker trapped);
    //   'error'   — the worker itself failed, e.g. ERR_WORKER_OUT_OF_MEMORY on the heap ceiling;
    //   'exit'    — a hard kill fires NEITHER 'message' NOR 'error'; without this the worker dies
    //               silently and we would wait out the full timeout, then misreport the cause;
    //   timeout   — a synchronous spin yields to nothing, so terminate() is the only way out.
    // Whichever fires first wins; `settle` guarantees exactly one resolution and always reclaims
    // the thread.
    //
    // `timer` and `worker` are declared before `settle` so it never closes over a binding that has
    // not been initialized yet. Every call site today runs after both are assigned, but reading the
    // reverse order requires proving that, and the guard is free.
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let worker: InstanceType<typeof Worker> | undefined;

    // `awaitTermination` is only true for the spin path. Elsewhere the thread is already finished or
    // unwinding, so waiting adds latency for nothing; a spinning worker is still burning a core, and
    // returning before it is gone lets threads stack up across a registry-wide pass.
    const settle = (result: GateResult, awaitTermination = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stopped = worker ? worker.terminate() : Promise.resolve(0);
      if (awaitTermination) void stopped.then(() => resolve(result), () => resolve(result));
      else resolve(result);
    };

    try {
      worker = new Worker(SMOKE_WORKER_SRC, {
        eval: true,
        workerData: { html, jsdomHref },
        resourceLimits: SMOKE_RESOURCE_LIMITS,
      });
    } catch (err) {
      resolve({ ok: false, failures: [`smoke could not start: ${errText(err)}`] });
      return;
    }

    timer = setTimeout(
      () => settle({ ok: false, failures: [`smoke did not finish within ${SMOKE_TIMEOUT_MS}ms (infinite loop?)`] }, true),
      SMOKE_TIMEOUT_MS,
    );

    worker.on("message", (result: GateResult) => settle(result));
    // Name the cause rather than guessing at it — these strings go back to the authoring agent as the
    // self-repair loop's error signal, and "out of memory?" on a setup failure sends it after the
    // wrong fix. V8 reports a breached resourceLimit as ERR_WORKER_OUT_OF_MEMORY.
    worker.on("error", (err: NodeJS.ErrnoException) =>
      settle({
        ok: false,
        failures: [
          err?.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? `smoke exceeded the ${SMOKE_RESOURCE_LIMITS.maxOldGenerationSizeMb}MB memory ceiling (runaway allocation?)`
            : `smoke worker failed: ${errText(err)}`,
        ],
      }),
    );
    worker.on("exit", (code) =>
      settle({
        ok: false,
        failures: [
          code === 0
            ? "smoke worker exited without reporting a result"
            : `smoke worker exited before reporting (code ${code})`,
        ],
      }),
    );
  });
}

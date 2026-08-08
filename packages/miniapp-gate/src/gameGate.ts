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

/** What the DOM looked like after the bundle's scripts ran. Produced inside the smoke worker — it is
 *  the only place that can see it — and consumed by typed check functions on the main thread. */
export interface RenderDigest {
  title: string | null;
  ids: string[];                              // document order; duplicates detectable, and nameable
  bodyElementCount: number;                   // rendered element nodes under <body>
  controls: {
    tag: string;                              // button, a[href], [role=button]
    /** APPROXIMATE. textContent + aria-label + resolved aria-labelledby — NOT the accessible-name
     *  algorithm, which jsdom does not implement. Named `nameHint` so no caller mistakes it for
     *  accname; the check that reads it is `warn`, never `fail`, because the input is a heuristic. */
    nameHint: string;
  }[];
  images: { hasAlt: boolean; src: string }[];
  jsonBlocks: { id: string; parses: boolean; empty: boolean; bytes: number }[];
  /** External URLs on nodes that are IN the DOM after execution. Does NOT catch a detached
   *  `new Image().src = url` — that element is never attached, so no DOM walk can see it. Closing
   *  that needs setter instrumentation; tracked in TODOS.md. */
  attachedExternal: string[];
  ariaRefs: { attr: string; target: string; resolves: boolean }[];
  hasCanvas: boolean;
  hasVectorOrImageContent: boolean;           // svg / img / canvas present
}

/** `staticGate` never executes anything, so it has nothing to say about a digest. Keeping its result
 *  narrower than `GateResult` is what lets it stay a pure syntax check. */
export interface StaticGateResult { ok: boolean; failures: string[] }

export interface GateResult extends StaticGateResult {
  /** NEVER optional, and three states rather than two.
   *
   *  "not-requested" — the caller passed no `digest: true`. Two of the three gameGate call sites read
   *                    only `.ok`, and one of those runs once per miniapp in a registry-wide pass.
   *  "not-executed"  — a digest was asked for and could not be produced: the static gate
   *                    short-circuited, or the smoke never ran. NOT a pass. Nothing was examined.
   *
   *  Collapsing these two would make an opt-out call site indistinguishable from a bundle that never
   *  ran, and an optional field would make "skip the checks entirely" the easiest code to write. */
  digest: RenderDigest | "not-requested" | "not-executed";
}

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

  // Narrow the NETWORK_CALL scan to executable script bodies. Default "document" preserves the sealed
  // miniapp contract, where the whole bundle IS code. Reports pass "executable": they are documents
  // ABOUT code, so `fetch` appears in prose that a document-wide scan cannot tell from a call.
  scanScope?: "document" | "executable";

  // Produce a RenderDigest. OFF by default, and deliberately so: of the three gameGate call sites,
  // two read only `.ok` and one of those runs once per miniapp inside migrateAllMiniapps. At a
  // measured ~300ms warm / ~520ms cold per entry, a DOM walk those callers discard multiplies across
  // the whole registry.
  digest?: boolean;
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
type Region = { text: string; role: "markup" | "code" | "data" };

// ONE tokenizer walk, three roles. Both scan surfaces below are filters over it, because a second
// hand-rolled walk is exactly where the two would drift on the fake-JSON-open trap the tests cover.
//   markup — everything outside a script body, INCLUDING the <script …> open tag (keeps src= attrs)
//   code   — the body of a script that is not application/json
//   data   — the body of a script that IS application/json (inert; baked session/report data)
function scriptRegions(html: string): Region[] {
  const lower = html.toLowerCase();
  const out: Region[] = [];
  let i = 0;
  for (;;) {
    const open = lower.indexOf("<script", i);
    if (open === -1) { out.push({ text: html.slice(i), role: "markup" }); break; }
    const gt = html.indexOf(">", open);
    if (gt === -1) { out.push({ text: html.slice(i), role: "markup" }); break; } // malformed open tag → keep the rest, scan it
    const close = lower.indexOf("</script>", gt);
    const contentEnd = close === -1 ? html.length : close;
    const elemEnd = close === -1 ? html.length : close + "</script>".length;
    out.push({ text: html.slice(i, gt + 1), role: "markup" });
    out.push({ text: html.slice(gt + 1, contentEnd), role: JSON_TYPE.test(html.slice(open, gt + 1)) ? "data" : "code" });
    out.push({ text: html.slice(contentEnd, elemEnd), role: "markup" }); // the </script>
    i = elemEnd;
  }
  return out;
}

export function scannableCode(html: string): string {
  return scriptRegions(html).filter((r) => r.role !== "data").map((r) => r.text).join("");
}

// EXECUTABLE bodies only — no markup, no prose, no inert data.
//
// This exists for REPORTS. A miniapp's text is all code, so scanning the whole document for `fetch`
// is right for it. A report is a document ABOUT code: "the agent's fetch calls failed" is a headline,
// not a call, and failing a report for describing the thing it exists to describe is a false positive
// on a large slice of real sessions. Turning the scan off for reports is not the alternative — a
// report is served with no CSP, so a genuine fetch() would fire when opened.
//
// Joined with "\n" so a token cannot merge across two script bodies and defeat the \b anchors.
//
// Known limit: an inline event-handler attribute (onclick="fetch(…)") is markup, so it is outside
// this surface. Tracked in the render-verification-gate design under Failure modes.
function scriptCode(html: string): string {
  return scriptRegions(html).filter((r) => r.role === "code").map((r) => r.text).join("\n");
}

export function staticGate(html: string, opts: GateOptions = {}): StaticGateResult {
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
  // The network scan alone narrows with scanScope. EXTERNAL_ATTR and BARE_IMPORT stay document-wide
  // under either scope: an external `src` is a real self-containment violation wherever it sits, and
  // it lives in markup, which `scriptCode` deliberately excludes.
  const netSurface = opts.scanScope === "executable" ? scriptCode(html) : code;

  if (!opts.allowNetwork && NETWORK_CALL.test(netSurface)) {
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

// Elements that occupy no visual space. \`bodyElementCount\` excludes them so a body holding only a
// <script> reads as 0 — "rendered nothing" — rather than as one element of content.
const NON_RENDERED = new Set(["SCRIPT", "STYLE", "TEMPLATE", "LINK", "META", "TITLE", "NOSCRIPT"]);
const EXTERNAL_URL = /^(?:https?:)?\\/\\//i;

function buildDigest(doc) {
  const all = (sel) => Array.from(doc.querySelectorAll(sel));

  // APPROXIMATE, and named so at the type. The real accessible-name algorithm is not in jsdom; this
  // is text + aria-label + resolved aria-labelledby, which is enough to tell "has a name" from
  // "has none" and nothing more.
  const nameHint = (el) => {
    const byIds = (el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean)
      .map((id) => { const t = doc.getElementById(id); return t ? (t.textContent || "") : ""; }).join(" ");
    return ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "") + " " + byIds)
      .replace(/\\s+/g, " ").trim();
  };

  const ariaRefs = [];
  for (const attr of ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns"]) {
    for (const el of all("[" + attr + "]")) {
      for (const target of (el.getAttribute(attr) || "").split(/\\s+/).filter(Boolean)) {
        ariaRefs.push({ attr, target, resolves: !!doc.getElementById(target) });
      }
    }
  }

  const jsonBlocks = all('script[type="application/json"]').map((s) => {
    const text = s.textContent || "";
    try {
      const v = JSON.parse(text);
      const empty = v === null || v === undefined || v === ""
        || (Array.isArray(v) && v.length === 0)
        || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
      return { id: s.id || "", parses: true, empty, bytes: text.length };
    } catch (_) {
      return { id: s.id || "", parses: false, empty: true, bytes: text.length };
    }
  });

  const attachedExternal = [];
  for (const el of all("[src],[href]")) {
    const url = el.getAttribute("src") || el.getAttribute("href") || "";
    if (EXTERNAL_URL.test(url)) attachedExternal.push(url);
  }

  const body = doc.body;
  return {
    title: doc.title || null,
    ids: all("[id]").map((el) => el.id),
    bodyElementCount: body
      ? Array.from(body.querySelectorAll("*")).filter((el) => !NON_RENDERED.has(el.tagName)).length
      : 0,
    controls: all('button, a[href], [role="button"]').map((el) => ({ tag: el.tagName.toLowerCase(), nameHint: nameHint(el) })),
    images: all("img").map((el) => ({ hasAlt: el.hasAttribute("alt"), src: el.getAttribute("src") || "" })),
    jsonBlocks,
    attachedExternal,
    ariaRefs,
    hasCanvas: !!doc.querySelector("canvas"),
    hasVectorOrImageContent: !!doc.querySelector("svg, img, canvas"),
  };
}

(async () => {
  const failures = [];
  let digest;
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

    // Snapshot the DOM the scripts BUILT, before the window closes. Only when asked: two of the three
    // gameGate call sites read just \`.ok\`, and one runs per-miniapp in a registry-wide pass.
    //
    // NOT a rendering contract. Two ticks is what the load-smoke needs; a document that paints on
    // requestAnimationFrame or a delayed timer is not finished here. Every check that reads this
    // snapshot must be severity "warn", never "fail" — see checks.ts.
    //
    // A throw in here leaves \`digest\` absent, which surfaces as "not-executed". Deliberate: our own
    // walk failing must not fail a user's Save.
    if (workerData.wantDigest) {
      try { digest = buildDigest(dom.window.document); } catch (_) { /* absent → "not-executed" */ }
    }
    dom.window.close();
  } catch (err) {
    failures.push("bundle failed to load: " + (err && err.message ? err.message : String(err)));
  }
  parentPort.postMessage({ ok: failures.length === 0, failures, digest });
})();
`;

// Tier-1 continued: a load-smoke. Execute the bundle's inline scripts in a jsdom DOM (no network:
// resources are not fetched) and catch an uncaught throw in the first tick. jsdom cannot see a blank
// canvas — visual correctness is the human preview's job (Tier-2) — but it reliably catches the large
// class of "broken on load" failures the self-repair loop iterates against.
export async function gameGate(html: string, opts: GateOptions = {}): Promise<GateResult> {
  // Why the digest state is decided here and threaded through every exit: each `return` below is a
  // path where no DOM was ever produced, and the type refuses to let one of them stay silent about it.
  const wantDigest = opts.digest === true;
  const noDigest = wantDigest ? "not-executed" : "not-requested";

  const staticResult = staticGate(html, opts);
  if (!staticResult.ok) return { ...staticResult, digest: noDigest }; // short-circuit; don't execute a non-sealed bundle

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
    return { ok: false, failures: [`smoke could not start: ${errText(err)}`], digest: noDigest };
  }

  return await new Promise<GateResult>((resolve) => {
    // FOUR settle paths, and all four are load-bearing. Whichever fires first wins; `settle`
    // guarantees exactly one resolution and always reclaims the thread.
    //
    //                         ┌──────────────────────────┐
    //                         │  Worker (isolated thread) │
    //                         │  jsdom parse → execute    │
    //                         │  → 2 ticks → digest?      │
    //                         └────────────┬─────────────┘
    //                                      │
    //        ┌──────────────┬──────────────┼──────────────┬────────────────┐
    //        │              │              │              │                │
    //    'message'       'error'        'exit'         timeout        (construction
    //   reported ok    worker died   died silently   never yielded      threw)
    //   or failures    e.g. OOM on   — fires NEITHER  — a sync spin    → resolve()
    //   incl. async    the heap      message NOR      yields to        directly,
    //   escapes the    ceiling       error, so        nothing, so      no worker
    //   worker         (V8:          without this     terminate() is   exists yet
    //   trapped        ERR_WORKER_   we'd wait out    the only exit
    //                  OUT_OF_       the full          → awaitTermination
    //                  MEMORY)       timeout and       so a burning
    //                                misreport         core is gone
    //                                the cause         before we return
    //        │              │              │              │
    //        └──────────────┴──────────────┼──────────────┘
    //                                      ▼
    //                            settle(result, awaitTermination?)
    //                            ├── settled? → drop (exactly-once)
    //                            ├── clearTimeout
    //                            ├── worker.terminate()
    //                            └── resolve(result)
    //
    // Only 'message' can carry a digest. Every other path means no DOM was ever examined, so each
    // resolves with `noDigest` — never an empty digest, which would read as "checked, clean".
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
        workerData: { html, jsdomHref, wantDigest },
        resourceLimits: SMOKE_RESOURCE_LIMITS,
      });
    } catch (err) {
      resolve({ ok: false, failures: [`smoke could not start: ${errText(err)}`], digest: noDigest });
      return;
    }

    timer = setTimeout(
      () => settle({ ok: false, failures: [`smoke did not finish within ${SMOKE_TIMEOUT_MS}ms (infinite loop?)`], digest: noDigest }, true),
      SMOKE_TIMEOUT_MS,
    );

    // The worker reports `digest` only when one was asked for AND the walk succeeded. Absent means
    // nothing was examined, which is `noDigest` — never an empty digest, which would read as clean.
    worker.on("message", (msg: { ok: boolean; failures: string[]; digest?: RenderDigest }) =>
      settle({ ok: msg.ok, failures: msg.failures, digest: msg.digest ?? noDigest }));
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
        digest: noDigest,
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
        digest: noDigest,
      }),
    );
  });
}

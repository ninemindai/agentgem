# @ninemind/miniapp-gate

Admission gate and bake-time redaction for generated single-file miniapp bundles.

A "miniapp" here is one self-contained HTML file — markup, styles, and scripts
inlined — produced by a model and then hosted. This package answers two questions
a host has to answer before it will serve one:

1. **Will this bundle load at all?** (`staticGate`, `gameGate`)
2. **Is the data baked into it free of the obvious author-identifying bits?**
   (`redactForBake`)

It is host-neutral: it imports nothing from its home project, and the load-smoke
runs in a worker thread so a hostile or merely broken bundle cannot take the host
process down.

## Read this before using it

**This is an admission heuristic, not a security boundary.**

`gameGate` evaluates the bundle with jsdom using `runScripts: "dangerously"`,
which jsdom's own documentation states is **not** a sandbox. Call it only on
bundles produced under your own control — never on untrusted or downloaded input
in a process you care about.

The static checks catch obvious external-reference and network *syntax*. They do
not stop dynamic exfiltration: `new Image().src = url` passes them. The real seal
is whatever you enforce at runtime — a CSP sandbox (`default-src 'none'`) or an
equivalent. This package tells you a bundle is *admissible*; it does not make it
*safe*.

`redactForBake` is likewise best-effort scrubbing, not a guarantee. A determined
leak in free-form text can still slip through.

## Install

```sh
npm install @ninemind/miniapp-gate
```

Node 24+. `jsdom` is a real runtime dependency — it is resolved lazily, inside
the smoke worker, so it costs nothing until you call `gameGate`.

## Usage

```js
import { staticGate, gameGate, redactForBake } from "@ninemind/miniapp-gate";

// Cheap, synchronous: size + external-reference + bare-import + network scan.
const quick = staticGate(html);
if (!quick.ok) console.error(quick.failures);

// Everything staticGate does, plus a real load-smoke in a worker thread.
const full = await gameGate(html);
// => { ok: false, failures: ["inline script threw: Uncaught [TypeError: …]"] }

// Scrub source data BEFORE baking it into a publicly-runnable bundle.
const safe = redactForBake({ path: "/Users/you/proj/app.ts", note: "sk-…" });
// => { path: "app.ts", note: "‹redacted›" }
```

## API

| Export | Signature | Notes |
|---|---|---|
| `staticGate` | `(html, opts?) => GateResult` | Synchronous. No jsdom, no worker. |
| `gameGate` | `(html, opts?) => Promise<GateResult>` | Static checks **plus** the worker load-smoke. ~300ms warm, ~520ms cold. |
| `scannableCode` | `(html) => string` | The script/attribute text the scans run against. |
| `redactForBake` | `(data: unknown) => unknown` | Walks the value; returns a redacted copy. |

`GateResult` is `{ ok: boolean; failures: string[] }` — `failures` are named
reasons suitable for feeding back to a generator as a repair signal.

### `GateOptions`

| Option | Default | Meaning |
|---|---|---|
| `maxBytes` | `1_500_000` (1.5 MB) | Size ceiling. Archives and shares well. |
| `allowNetwork` | `false` | Skip the network-call scan. **Host policy, not a weakening.** |

Leave `allowNetwork` off when your host *seals* bundles (no network, no origin) —
the scan is then one of the things that makes "sealed" checkable at admission
time. Turn it on when you confine bundles at *runtime* instead, e.g. serving each
one under `default-src 'none'; connect-src <one origin>` in a null-origin iframe.
There, a browser-enforced allowlist is strictly stronger than a regex over source,
and scanning for the word `fetch` would forbid the very mechanism the host runs on.

The other checks (size, external attributes, bare imports) stay on either way:
failing at admission with a named reason beats rendering silently broken.

## What `redactForBake` removes

- The home directory path, rewritten to `~`.
- Common secret shapes: `sk-…`, `ghp_/gho_/ghu_/ghs_/ghr_…`, `AKIA…`,
  `xoxb-/xoxp-…`, and JWTs → `‹redacted›`.
- `path` values and `files` entries reduced to their basename.
- `timeline` arrays truncated to 500 entries.

## Why the smoke runs in a worker

Generated code has three ways to take a host down, and only an isolation boundary
covers all three:

- an **async throw** escaping to `uncaughtException` — observed in the wild:
  `new Path2D(...)` inside an awaited `boot()` killed the app mid-save;
- a **synchronous spin** (`while(true){}`), which blocks the event loop so no
  handler runs at all — there is nothing to trap and the process cannot recover;
- **unbounded allocation**.

A worker contains all three: async throws arrive on `'error'`, `terminate()`
interrupts a tight loop, and `resourceLimits` bounds the heap. In a long-lived
server that gates on every save, the alternative meant one generated `while(true)`
stopped health checks from responding.

## License

MIT © NineMind, Inc. See [LICENSE](./LICENSE).

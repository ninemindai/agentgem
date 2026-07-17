// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Canonical watch-registry identity for an in-flight/watched MCP call: normalizes `input` into the exact
// JSON value the poll will send to `/call` (the `body`), and derives a collision-free, deterministic `key`
// from server+tool+that normalized body. Two logically-identical inputs (key order aside) MUST coalesce to
// the same key; two different inputs MUST NOT. Object keys are inserted recursively in sorted order (so
// JSON.stringify of the body is stable/deterministic regardless of the input's original key order — note
// that for canonical-integer string keys, e.g. "2"/"10", JS itself always iterates them in ascending
// numeric order ahead of the sort() order, which is still deterministic, just not lexicographic); arrays
// keep their given order (order is meaningful there). Only JSON
// scalars (string/finite number/boolean/null), arrays, and plain objects are supported — anything else
// (Date, function, BigInt, NaN/Infinity, symbol) throws McpIdentityError rather than silently coercing or
// dropping, since a silent drop could collide two different calls. Pure/browser-safe: no imports beyond
// what's needed, so the browser-bundled console can pull it in directly.

export class McpIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpIdentityError";
  }
}

// Recursively normalize into a new value whose object keys are inserted in sorted order (so JSON.stringify's
// output no longer depends on the input's key order — though for canonical-integer keys, JS's own numeric
// iteration order wins over insertion order regardless; still deterministic, just engine-defined) and whose
// only shapes are JSON scalars/arrays/plain objects. `undefined`
// values inside an object are dropped (matches JSON.stringify's own behavior for object properties); a
// top-level `undefined` is handled by the caller as the empty call, not here.
function normalize(value: unknown): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) throw new McpIdentityError(`unsupported number: ${String(value)}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new McpIdentityError(`unsupported value: ${Object.prototype.toString.call(value)}`);
    }
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] === undefined) continue; // dropped, same as JSON.stringify
      out[k] = normalize(src[k]);
    }
    return out;
  }
  // function, symbol, bigint, undefined-as-a-value (handled above for objects/top-level separately)
  throw new McpIdentityError(`unsupported value type: ${t}`);
}

export function mcpIdentity(server: string, tool: string, input?: unknown): { key: string; body: unknown } {
  const body = input === undefined ? {} : normalize(input);
  // `server`/`tool` are unconstrained strings (arbitrary upstream MCP server/tool names), so any
  // delimiter-based join (e.g. `server:${server}|tool:${tool}|...`) is collision-prone: distinct
  // (server, tool) pairs can straddle the delimiters and serialize identically. A JSON array is
  // unambiguous about element boundaries regardless of what characters its elements contain, so
  // key off that instead.
  const key = JSON.stringify([server, tool, body]);
  return { key, body };
}

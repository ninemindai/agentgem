// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Typed checks over a RenderDigest — the consumer half of the split that keeps the smoke worker's
// eval'd source string small.
//
// WHY THESE ARE NOT IN THE WORKER. `SMOKE_WORKER_SRC` is a source string run with `{ eval: true }`,
// so nothing in it is typechecked and its own comment asks that it stay small. Baking a selectable
// check registry in there would have grown the untyped region AND put report-shaped knowledge inside
// a published, host-neutral package. Instead the worker produces one structured snapshot and every
// check is an ordinary function: typechecked, unit-testable against a literal, and free of a worker.
//
// SEVERITY IS A PROPERTY OF THE CHECK, NOT OF THE CALL SITE. `fail` means the document is broken and
// blocks a Save (or triggers one report repair turn); `warn` means it is imperfect and rides along.
// A check whose INPUT is approximate must be `warn` — see `blank-render` and `unnamed-control`.
import type { RenderDigest } from "./gameGate.js";

export type Severity = "fail" | "warn";

export interface Finding {
  /** Stable across runs, so a UI can style, group, or mute one check. */
  id: string;
  severity: Severity;
  /** Reads to the authoring agent as a repair instruction, not as a log line. */
  message: string;
  /** The specific offender. A finding that says "something is duplicated" without saying what turns
   *  the repair turn into a scavenger hunt. */
  evidence?: string;
}

export type Check = (d: RenderDigest) => Finding[];

/** Run a set of checks and order the result so the blocking reasons read first. */
export function runChecks(d: RenderDigest, checks: Check[]): Finding[] {
  const all = checks.flatMap((c) => c(d));
  return all.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1));
}

const one = (id: string, severity: Severity, message: string, evidence?: string): Finding[] =>
  [{ id, severity, message, ...(evidence === undefined ? {} : { evidence }) }];

// ─── fail: the document is broken ────────────────────────────────────────────

const duplicateId: Check = (d) => {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of d.ids) (seen.has(id) ? dupes : seen).add(id);
  if (dupes.size === 0) return [];
  // Not cosmetic: getElementById returns the first match, so every later duplicate is unreachable and
  // every aria reference pointing at one silently resolves to the wrong node.
  return one("duplicate-id", "fail", "Two or more elements share an id, so getElementById and every aria reference to them resolve to the wrong node. Make each id unique.", [...dupes].join(", "));
};

const attachedExternalResource: Check = (d) =>
  d.attachedExternal.length === 0 ? [] :
    one("attached-external-resource", "fail", "The document loads a resource from the network after it runs. Everything must be inline or a data: URI.", d.attachedExternal.join(", "));

// ─── warn: the document is imperfect ─────────────────────────────────────────

const blankRender: Check = (d) => {
  // Vector and image content is real content with no element count to speak of, and a canvas app is
  // the common miniapp shape. Both would be condemned by a naive emptiness test.
  if (d.bodyElementCount > 0 || d.hasVectorOrImageContent || d.hasCanvas) return [];
  // WARN, never FAIL. The digest is taken after the smoke's two setTimeout(0) ticks, which is enough
  // to catch a throw on load but is NOT a rendering contract — a document that paints on
  // requestAnimationFrame or a delayed timer is simply not finished yet. Promoting this to a gate
  // needs a trustworthy settle condition first; tracked in TODOS.md.
  return one("blank-render", "warn", "The document rendered no visible elements. It may be genuinely empty, or it may paint later than the gate looks — verify in a browser.");
};

const unnamedControl: Check = (d) => {
  const bare = d.controls.filter((c) => c.nameHint.trim() === "");
  if (bare.length === 0) return [];
  // Reads the APPROXIMATE nameHint, so this can only ever be advice. jsdom has no accessible-name
  // algorithm; a control named by a mechanism the hint does not model would be a false positive, and
  // false positives must not block a Save.
  return one("unnamed-control", "warn", "A control has no text, aria-label, or aria-labelledby, so assistive technology announces nothing for it.", bare.map((c) => c.tag).join(", "));
};

const missingAlt: Check = (d) => {
  const n = d.images.filter((i) => !i.hasAlt).length;
  return n === 0 ? [] :
    one("missing-alt", "warn", `${n} image${n === 1 ? " has" : "s have"} no alt attribute. Decorative images want alt="".`);
};

const brokenAriaRef: Check = (d) => {
  const broken = d.ariaRefs.filter((r) => !r.resolves);
  return broken.length === 0 ? [] :
    one("broken-aria-ref", "warn", "An aria attribute points at an id that is not in the document, so the relationship it declares does not exist.", broken.map((r) => `${r.attr}="${r.target}"`).join(", "));
};

/** Checks that describe ANY self-contained document. Report- and miniapp-specific sets compose with
 *  this one rather than replacing it. */
export const SHARED_CHECKS: Check[] = [
  duplicateId,
  attachedExternalResource,
  blankRender,
  unnamedControl,
  missingAlt,
  brokenAriaRef,
];

/** Every id this module can emit. A drift guard can iterate it, and a UI can enumerate what is
 *  mutable, without importing the check functions themselves. */
export const SHARED_CHECK_IDS = [
  "duplicate-id",
  "attached-external-resource",
  "blank-render",
  "unnamed-control",
  "missing-alt",
  "broken-aria-ref",
] as const;

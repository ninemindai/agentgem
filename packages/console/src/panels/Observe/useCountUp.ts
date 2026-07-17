import { useEffect, useRef, useState } from "react";

const DURATION_MS = 900;

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Ticks a row of numbers from their last-displayed values up to new `targets`,
 *  driven by ONE shared requestAnimationFrame loop (not one timer per figure) —
 *  the reveal panel can have 7+ animated numbers (hero + ledger) and they must
 *  move in lockstep. First mount starts from zero, so a fresh (uncached) scan
 *  ticks 0 → final; if a `stale` scorecard frame already populated `targets`
 *  before this ever mounted with real data, the first animated leg is
 *  stale → final instead, since "from" is always the previously *displayed*
 *  row, not a fixed zero baseline. `prefers-reduced-motion` skips the animation
 *  entirely and snaps straight to `targets`. */
export function useCountUp(targets: number[]): number[] {
  const [display, setDisplay] = useState<number[]>(() => targets.map(() => 0));
  const displayRef = useRef(display);
  displayRef.current = display;
  const rafRef = useRef<number | null>(null);
  const reduced = useRef(prefersReducedMotion());
  const key = targets.join(",");

  useEffect(() => {
    if (reduced.current) {
      setDisplay(targets);
      return;
    }
    const from = displayRef.current.length === targets.length ? displayRef.current : targets.map(() => 0);
    const to = targets;
    if (from.every((v, i) => v === to[i])) return; // nothing to animate
    // Anchor "started" to the first rAF callback's own timestamp rather than a
    // separately-captured performance.now() — some environments (jsdom's rAF
    // shim included) hand the callback a clock that doesn't share an origin
    // with performance.now(), which would otherwise make `elapsed` huge or
    // negative and blow the easing curve past 0/1.
    let startedAt: number | null = null;

    const step = (now: number) => {
      if (startedAt == null) startedAt = now;
      const elapsed = now - startedAt;
      const p = Math.min(1, Math.max(0, elapsed / DURATION_MS));
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      setDisplay(from.map((f, i) => Math.round(f + (to[i] - f) * eased)));
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return display;
}

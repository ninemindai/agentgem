import { useCallback, useRef, useState } from "react";

/** Pure: shift `startValue` by `delta` (negated for end-side handles) and clamp. */
export function applyDrag(
  startValue: number,
  delta: number,
  o: { min: number; max: number; invert?: boolean },
): number {
  const raw = startValue + (o.invert ? -delta : delta);
  return Math.max(o.min, Math.min(o.max, raw));
}

export type DragResizeOpts = {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  /** Fired on pointer-up / key commit — lets a caller resolve a raw value (e.g. snap). */
  onCommit?: (n: number) => void;
  /** Handle sits on the pane's END edge; dragging right shrinks the pane. */
  invert?: boolean;
  /** Keyboard nudge in px (default 16). */
  step?: number;
};

export function useDragResize(o: DragResizeOpts) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; value: number } | null>(null);
  const step = o.step ?? 16;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    start.current = { x: e.clientX, value: o.value };
    setDragging(true);
    (e.target as Element).setPointerCapture?.(e.pointerId); // jsdom: no-op
  }, [o.value]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!start.current) return;
    o.onChange(applyDrag(start.current.value, e.clientX - start.current.x, o));
  }, [o]);

  const end = useCallback(() => {
    if (start.current) o.onCommit?.(o.value);
    start.current = null;
    setDragging(false);
  }, [o]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Keyboard operates directly on `value` (no invert) so Right always = larger.
    const d = e.key === "ArrowRight" ? step
      : e.key === "ArrowLeft" ? -step
      : e.key === "End" ? 1e7
      : e.key === "Home" ? -1e7
      : null;
    if (d == null) return;
    e.preventDefault();
    const next = applyDrag(o.value, d, { min: o.min, max: o.max });
    o.onChange(next);
    o.onCommit?.(next);
  }, [o, step]);

  return {
    dragging,
    handleProps: {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-valuenow": Math.round(o.value),
      "aria-valuemin": o.min,
      "aria-valuemax": o.max,
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onKeyDown,
    } as Record<string, unknown>,
  };
}

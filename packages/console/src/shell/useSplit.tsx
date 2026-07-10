import { useEffect, useState } from "react";
import { useDragResize } from "./useDragResize.js";

const keyFor = (id: string) => `agentgem.console.split.${id}`;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function load(id: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(keyFor(id)));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch { return fallback; }
}

export function useSplit(
  id: string,
  o: { initial: number; min: number; max: number; side?: "start" | "end" },
) {
  // A stale/foreign stored value can be out of range; the drag path is clamped
  // by useDragResize, but the restore path is not — clamp it here.
  const [size, setSize] = useState(() => clamp(load(id, o.initial), o.min, o.max));
  useEffect(() => {
    try { localStorage.setItem(keyFor(id), String(size)); } catch { /* storage unavailable */ }
  }, [id, size]);

  const { dragging, handleProps } = useDragResize({
    value: size,
    min: o.min,
    max: o.max,
    onChange: setSize,
    invert: o.side === "end",
  });

  return {
    containerProps: {
      style: { ["--split" as string]: `${size}px` } as React.CSSProperties,
      className: dragging ? "is-dragging" : "",
    },
    handle: <span className="split-handle" data-side={o.side ?? "start"} aria-label="Resize panel" {...handleProps} />,
  };
}

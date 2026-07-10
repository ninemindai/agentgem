import { useCallback, useEffect, useRef, useState } from "react";
import { useDragResize } from "./useDragResize.js";

export const RAIL_W = 56;
export const FULL_MIN = 190;
export const FULL_MAX = 420;
export const SNAP_THRESHOLD = 130;
export const DEFAULT_WIDTH = 244;

/** Snap a raw dragged width to the rail or clamp it to the full-mode band. */
export function resolveWidth(raw: number): number {
  if (raw < SNAP_THRESHOLD) return RAIL_W;
  return Math.max(FULL_MIN, Math.min(FULL_MAX, raw));
}

export function isRail(width: number): boolean {
  return width <= RAIL_W;
}

export type RailState = { width: number; collapsed: boolean };
const KEY = "agentgem.console.rail";

export function loadRail(): RailState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "");
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      const width = typeof o.width === "number" ? resolveWidth(o.width) : DEFAULT_WIDTH;
      return { width, collapsed: o.collapsed === true };
    }
  } catch { /* absent or malformed → defaults */ }
  return { width: DEFAULT_WIDTH, collapsed: false };
}

export function saveRail(s: RailState): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export function useSidebar() {
  const initial = useRef(loadRail());
  // rawWidth is the continuous drag variable; display width is its snap.
  const [rawWidth, setRawWidth] = useState(initial.current.width);
  const [collapsed, setCollapsed] = useState(initial.current.collapsed);
  const width = resolveWidth(rawWidth);

  useEffect(() => { saveRail({ width, collapsed }); }, [width, collapsed]);

  const { dragging, handleProps } = useDragResize({
    value: rawWidth,
    min: RAIL_W,
    max: FULL_MAX,
    onChange: setRawWidth,
    onCommit: (v) => setRawWidth(resolveWidth(v)), // settle handle onto the snapped position
  });

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCollapsed]);

  return {
    width: collapsed ? 0 : width,
    collapsed,
    isRail: !collapsed && isRail(width),
    dragging,
    handleProps,
    toggleCollapsed,
  };
}

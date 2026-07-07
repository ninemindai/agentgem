// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/_shared/BloatCurve.tsx
import { useEffect, useRef } from "react";

export interface CurvePoint { turn: number; msgIndex: number; ctxTokens: number; cacheCreation: number; outTokens: number }

export function BloatCurve({ curve, cap, width = 320, height = 90 }: { curve: CurvePoint[]; cap: number; width?: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const w = cv.width, h = cv.height, pad = 4;
    const cssVar = (k: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(k).trim() || fallback;
    const heat = cssVar("--accent", "#9a3324");
    const grid = cssVar("--muted", "#8a7f69");
    ctx.clearRect(0, 0, w, h);
    const N = curve.length; if (N === 0) return;
    const X = (i: number) => pad + (w - 2 * pad) * (N > 1 ? i / (N - 1) : 0);
    const Y = (v: number) => h - pad - (h - 2 * pad) * Math.min(1, v / cap);
    ctx.beginPath(); ctx.moveTo(X(0), h - pad);
    curve.forEach((p, i) => ctx.lineTo(X(i), Y(p.ctxTokens)));
    ctx.lineTo(X(N - 1), h - pad); ctx.closePath();
    ctx.fillStyle = heat + "22"; ctx.fill();
    ctx.beginPath(); curve.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.ctxTokens)) : ctx.moveTo(X(i), Y(p.ctxTokens))));
    ctx.strokeStyle = heat; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = grid; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad, Y(cap)); ctx.lineTo(w - pad, Y(cap)); ctx.stroke(); ctx.setLineDash([]);
  }, [curve, cap]);
  return <canvas ref={ref} width={width} height={height} className="hyg-canvas" role="img" aria-label="Context size per turn" />;
}

// Pure selection logic for the capture shim: pick the largest visible canvas (ties → first in DOM order).
// Kept out of the inline shim string so it is unit-testable; the shim inlines an equivalent tiny loop.
export function pickCaptureCanvas(canvases: HTMLCanvasElement[]): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null, bestArea = 0;
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) { best = c; bestArea = area; }
  }
  return best;
}

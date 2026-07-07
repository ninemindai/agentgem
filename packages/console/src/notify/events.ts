export interface NotifyEvent {
  key: string;
  title: string;
  message: string;
}
export interface WarmSnapshot { running: boolean }
export interface DreamSnapshot { queued: number }

export function detectWarm(prev: WarmSnapshot | null, next: WarmSnapshot): NotifyEvent | null {
  if (prev && prev.running && !next.running) {
    return {
      key: "warm-finished",
      title: "Warm pass finished",
      message: "Insights are freshly precomputed.",
    };
  }
  return null;
}

export function detectDream(prev: DreamSnapshot | null, next: DreamSnapshot): NotifyEvent | null {
  if (prev && next.queued > prev.queued) {
    const n = next.queued - prev.queued;
    return {
      key: "dream-queue",
      title: "New review-queue items",
      message: `${n} new item${n === 1 ? "" : "s"} to review.`,
    };
  }
  return null;
}

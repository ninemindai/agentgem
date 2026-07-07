import { useEffect, useRef } from "react";
import { useToast } from "../shell/Toast.js";
import { detectWarm, detectDream, type WarmSnapshot, type DreamSnapshot, type NotifyEvent } from "./events.js";
import { dispatch } from "./dispatch.js";
import { osNotify } from "./osNotify.js";
import { readNotifyPref } from "./prefs.js";

const POLL_MS = 5000;

// Mounted once in Shell. Polls warm + dream status, detects transitions, and
// routes events through dispatch. Renders nothing. Independent of WarmingPill's
// own poll (kept separate so the pill stays untouched).
export function NotificationsProvider({ apiBase }: { apiBase: string }): null {
  const { push } = useToast();
  const warmPrev = useRef<WarmSnapshot | null>(null);
  const dreamPrev = useRef<DreamSnapshot | null>(null);

  useEffect(() => {
    let alive = true;

    const fire = (event: NotifyEvent | null) => {
      if (!event || !alive) return;
      dispatch(event, {
        enabled: readNotifyPref(),
        hidden: document.visibilityState === "hidden" || !document.hasFocus(),
        toast: push,
        notify: osNotify,
      });
    };

    const poll = async () => {
      try {
        const [wr, dr] = await Promise.all([
          fetch(`${apiBase}/api/warm/status`),
          fetch(`${apiBase}/api/dream/status`),
        ]);
        if (!alive) return;
        if (wr.ok) {
          const w = (await wr.json()) as { running: boolean };
          const next: WarmSnapshot = { running: w.running };
          fire(detectWarm(warmPrev.current, next));
          warmPrev.current = next;
        }
        if (dr.ok) {
          const d = (await dr.json()) as { queued: number };
          const next: DreamSnapshot = { queued: d.queued };
          fire(detectDream(dreamPrev.current, next));
          dreamPrev.current = next;
        }
      } catch {
        /* best-effort — a failed poll leaves the baseline untouched */
      }
    };

    void poll();
    const h = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, [apiBase, push]);

  return null;
}

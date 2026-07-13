// Mounted once in Shell. Polls the report run list, exposes it via context for the
// activity menu, and fires the existing notify stack (toast + OS banner) when a run
// becomes terminal — mirroring NotificationsProvider's poll+detect+fire.
import { createContext, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useToast } from "../shell/Toast.js";
import { dispatch } from "./dispatch.js";
import { osNotify } from "./osNotify.js";
import { readNotifyPref } from "./prefs.js";
import { detectReportDone, type ReportSnapshot } from "./events.js";

const POLL_MS = 5000;

export interface ActivityRun { id: string; kind: string; paramsKey: string; status: "running" | "done" | "failed"; phase: string; startedAt: number }

const ActivityCtx = createContext<{ runs: ActivityRun[] }>({ runs: [] });
export const useActivity = (): { runs: ActivityRun[] } => useContext(ActivityCtx);

export function ActivityProvider({ apiBase, children }: { apiBase: string; children: ReactNode }): ReactElement {
  const { push } = useToast();
  const [runs, setRuns] = useState<ActivityRun[]>([]);
  const prev = useRef<ReportSnapshot | null>(null);
  const mountAt = useRef<number>(0);

  useEffect(() => {
    let alive = true;
    mountAt.current = Date.now();   // wall clock; matches server startedAt
    const poll = async () => {
      try {
        const r = await fetch(`${apiBase}/api/report/runs`);
        if (!alive || !r.ok) return;
        const list = ((await r.json()).runs as ActivityRun[]) ?? [];
        setRuns(list);
        const terminal: Record<string, "done" | "failed"> = {};
        const kindOf: Record<string, string> = {};
        const startedAt: Record<string, number> = {};
        for (const x of list) { kindOf[x.id] = x.kind; startedAt[x.id] = x.startedAt; if (x.status !== "running") terminal[x.id] = x.status; }
        const next: ReportSnapshot = { terminal, kindOf };
        for (const ev of detectReportDone(prev.current, next, { firstBaselineAt: mountAt.current, startedAt })) {
          dispatch(ev, { enabled: readNotifyPref(), hidden: document.visibilityState === "hidden" || !document.hasFocus(), toast: push, notify: osNotify });
        }
        prev.current = next;
      } catch { /* best-effort */ }
    };
    void poll();
    const h = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, [apiBase, push]);

  return <ActivityCtx.Provider value={{ runs }}>{children}</ActivityCtx.Provider>;
}

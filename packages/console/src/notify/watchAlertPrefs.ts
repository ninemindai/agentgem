export const LS_WATCH_ALERTS = "agentgem.watchAlerts";

export interface WatchAlertPrefs {
  mode: "all" | "selected";
  files: string[];
}

const DEFAULT: WatchAlertPrefs = { mode: "all", files: [] };

// The user asked for these alerts, so the default is on-for-everything; the Watch
// tab's bell toggles narrow it down (mode "selected") per session.
export function readWatchAlertPrefs(): WatchAlertPrefs {
  try {
    const raw = localStorage.getItem(LS_WATCH_ALERTS);
    if (!raw) return DEFAULT;
    const p = JSON.parse(raw) as Partial<WatchAlertPrefs>;
    if ((p.mode === "all" || p.mode === "selected") && Array.isArray(p.files) && p.files.every((f) => typeof f === "string")) {
      return { mode: p.mode, files: p.files };
    }
    return DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function writeWatchAlertPrefs(p: WatchAlertPrefs): void {
  try {
    localStorage.setItem(LS_WATCH_ALERTS, JSON.stringify(p));
  } catch {
    /* storage unavailable — preference just won't persist */
  }
}

export function enrolledFiles(prefs: WatchAlertPrefs, allFiles: string[]): Set<string> {
  return prefs.mode === "all" ? new Set(allFiles) : new Set(prefs.files.filter((f) => allFiles.includes(f)));
}

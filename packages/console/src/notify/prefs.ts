export const LS_NOTIFY = "agentgem.notify";

// The unset default. In the desktop app the native bridge (window.agentgem.notify) is
// present and needs no permission, so notifications are on out of the box. A plain browser
// can't fire a notification until the user grants OS permission on a click, so there it stays
// opt-in (off) until the bell is clicked. An explicit stored "on"/"off" always wins over this.
function defaultOn(): boolean {
  return typeof window !== "undefined" && Boolean(window.agentgem?.notify);
}

export function readNotifyPref(): boolean {
  try {
    const stored = localStorage.getItem(LS_NOTIFY);
    if (stored === "on") return true;
    if (stored === "off") return false;
    return defaultOn(); // unset — pick the platform-appropriate default
  } catch {
    return defaultOn();
  }
}

export function writeNotifyPref(on: boolean): void {
  try {
    localStorage.setItem(LS_NOTIFY, on ? "on" : "off");
  } catch {
    /* storage unavailable — preference just won't persist */
  }
}

export const LS_NOTIFY = "agentgem.notify";

export function readNotifyPref(): boolean {
  try {
    return localStorage.getItem(LS_NOTIFY) === "on";
  } catch {
    return false;
  }
}

export function writeNotifyPref(on: boolean): void {
  try {
    localStorage.setItem(LS_NOTIFY, on ? "on" : "off");
  } catch {
    /* storage unavailable — preference just won't persist */
  }
}

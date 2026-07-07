import type { NotifyEvent } from "./events.js";

export interface DispatchDeps {
  enabled: boolean;
  hidden: boolean;
  toast: (message: string) => void;
  notify: (title: string, body: string) => void;
}

// The master toggle gates everything. When on: always show a toast; escalate to
// an OS notification only when the window is hidden (the OS banner is the
// attention-getter the in-app toast can't be).
export function dispatch(event: NotifyEvent, deps: DispatchDeps): void {
  if (!deps.enabled) return;
  deps.toast(event.message);
  if (deps.hidden) deps.notify(event.title, event.message);
}

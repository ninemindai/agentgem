import { useState, type ReactElement } from "react";
import { readNotifyPref, writeNotifyPref } from "./prefs.js";

// Master on/off for notifications. In Electron (bridge present) enabling is a
// pure preference — the native path needs no permission. In a plain browser the
// first enable triggers the one-time permission prompt (on a user gesture).
export function NotifyBell(): ReactElement {
  const [on, setOn] = useState(() => readNotifyPref());
  const [blocked, setBlocked] = useState(
    () => "Notification" in window && Notification.permission === "denied",
  );

  const enable = async () => {
    const hasBridge = Boolean(window.agentgem?.notify);
    if (hasBridge) {
      writeNotifyPref(true);
      setOn(true);
      return;
    }
    if (!("Notification" in window)) return; // unsupported: leave off
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm === "granted") {
      writeNotifyPref(true);
      setOn(true);
    } else {
      setBlocked(perm === "denied");
    }
  };

  const toggle = () => {
    if (on) {
      writeNotifyPref(false);
      setOn(false);
    } else {
      void enable();
    }
  };

  const label = blocked
    ? "Notifications blocked by the browser"
    : on
      ? "Notifications on — click to turn off"
      : "Enable notifications";

  return (
    <button
      type="button"
      className={"notify-bell" + (on ? " is-on" : "") + (blocked ? " is-blocked" : "")}
      aria-pressed={on}
      title={label}
      aria-label={label}
      onClick={toggle}
    >
      {on ? "🔔" : "🔕"}
    </button>
  );
}

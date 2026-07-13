// A button showing the count of in-flight runs; the dropdown lists recent runs and
// deep-links to each one's panel (the panel reattaches the latest run of its kind).
import { useState, type ReactElement } from "react";
import { useActivity, type ActivityRun } from "./ActivityProvider.js";
import { KIND_LABEL, ROUTE_FOR } from "../report/kinds.js";

function label(r: ActivityRun): string {
  const kind = KIND_LABEL[r.kind] ?? r.kind;
  if (r.status === "running") return `${kind} — ${r.phase}`;
  if (r.status === "failed") return `${kind} — failed`;
  return `${kind} — done`;
}

export function ActivityMenu(): ReactElement {
  const { runs } = useActivity();
  const [open, setOpen] = useState(false);
  const active = runs.filter((r) => r.status === "running").length;

  const go = (r: ActivityRun) => { const route = ROUTE_FOR[r.kind]; if (route) window.location.hash = route; setOpen(false); };

  return (
    <div className="activity-menu">
      <button type="button" className={"activity-toggle" + (active > 0 ? " is-active" : "")}
        aria-label={active > 0 ? `${active} running report${active === 1 ? "" : "s"}` : "Report activity"}
        aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        🗂{active > 0 && <span className="activity-count">{active}</span>}
      </button>
      {open && (
        <div className="activity-pop" role="menu">
          {runs.length === 0
            ? <div className="activity-empty">No recent reports.</div>
            : runs.slice(0, 12).map((r) => (
                <button key={r.id} type="button" role="menuitem" className="activity-row" onClick={() => go(r)}>
                  <span className={"activity-dot activity-dot-" + r.status} aria-hidden="true" />{label(r)}
                </button>
              ))}
        </div>
      )}
    </div>
  );
}

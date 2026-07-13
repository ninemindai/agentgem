import { useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { useSubRouteTabs } from "../../shell/useSubRouteTabs.js";
import { ProjectScope } from "./ProjectScope.js";
import { WorkflowsView } from "./WorkflowsView.js";
import { OutcomesView } from "./OutcomesView.js";

const TABS = [
  { id: "workflows", label: "Workflows", route: "#/mine" },
  { id: "outcomes", label: "Outcomes", route: "#/mine/outcomes" },
] as const;

/** The Mine tab: a shared project selector over two views — Workflows (the
 *  deterministic scorecard) and Outcomes (the LLM-judged session report). */
export function Mine({ apiBase }: { apiBase: string }) {
  const [scope, setScope] = useState("*");
  const { idx, roving } = useSubRouteTabs(TABS.map((t) => t.route));

  return (
    <div className="mine-tab">
      <ProjectScope apiBase={apiBase} scope={scope} onChange={setScope} />
      <div className="console-tabs" role="tablist" aria-label="Mine" {...roving.containerProps}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={i === idx}
            className={"console-tab" + (i === idx ? " is-active" : "")}
            {...roving.getTabProps(i)}
            onClick={() => { window.location.hash = t.route; }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {idx === 1
          ? <OutcomesView apiBase={apiBase} scope={scope} />
          : <WorkflowsView apiBase={apiBase} scope={scope} />}
      </div>
    </div>
  );
}

export const minePage = defineConsolePage({
  id: "mine", title: "Mine", icon: "💎", order: 10, phase: "observe", category: "projects",
  route: "#/mine", component: Mine,
});

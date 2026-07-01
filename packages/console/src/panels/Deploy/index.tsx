import { defineConsolePage } from "../../registry.js";
import { useActiveGem } from "../../activeGem.js";
import { buildSelection } from "../Curate/selection.js";
import { Publish } from "./Publish.js";
import { WorkspaceDeploy } from "./WorkspaceDeploy.js";

export function Deploy({ apiBase }: { apiBase: string }) {
  const { keys, name } = useActiveGem();
  if (keys.size === 0) {
    return <p className="ledger-empty">Curate some artifacts first — <a href="#/curate">go to Curate →</a></p>;
  }
  const sel = buildSelection(keys);
  const gemName = name.trim() || "gem";
  return (
    <div className="deploy-stage">
      <Publish apiBase={apiBase} selection={sel} name={gemName} />
      <WorkspaceDeploy apiBase={apiBase} name={gemName} />
    </div>
  );
}

export const deployPage = defineConsolePage({
  id: "deploy",
  title: "Deploy",
  icon: "▲",
  order: 30,
  group: "build",
  requiresGem: true,
  route: "#/deploy",
  component: ({ apiBase }) => <Deploy apiBase={apiBase} />,
});

// packages/console/src/panels/Play/index.tsx
import { useEffect, useState } from "react";
import { defineConsolePage } from "../../contract.js";
import { preferredAgentId, type PlayAgent } from "./AgentSelector.js";
import { Arcade } from "./Arcade.js";
import { Composer } from "./Composer.js";
import { Studio } from "./Studio.js";

type View = { kind: "arcade" } | { kind: "composer" } | { kind: "studio"; name: string };
const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };

export function Play({ apiBase }: { apiBase: string }) {
  const [view, setView] = useState<View>({ kind: "arcade" });
  const [agents, setAgents] = useState<PlayAgent[] | null>(null);
  const [agentId, setAgentId] = useState("");

  useEffect(() => {
    fetch(`${apiBase}/api/agents`).then(j).then((data: { agents: PlayAgent[] }) => {
      setAgents(data.agents);
      setAgentId((current) => current || preferredAgentId(data.agents));
    }).catch(() => setAgents([]));
  }, [apiBase]);

  return (
    <section className="analyze">
      {view.kind !== "studio" && (
        <div className="play-tabs">
          <button className={`play-tab${view.kind === "arcade" ? " is-active" : ""}`} onClick={() => setView({ kind: "arcade" })}>Arcade</button>
          <button className={`play-tab play-tab--cta${view.kind === "composer" ? " is-active" : ""}`} onClick={() => setView({ kind: "composer" })}>+ New miniapp</button>
        </div>
      )}
      {view.kind === "arcade" && <Arcade apiBase={apiBase} onOpen={(name) => setView({ kind: "studio", name })} />}
      {view.kind === "composer" && <Composer apiBase={apiBase} agents={agents} agentId={agentId} onAgentIdChange={setAgentId} onCreated={(name) => setView({ kind: "studio", name })} />}
      {view.kind === "studio" && <Studio apiBase={apiBase} name={view.name} agents={agents} agentId={agentId} onAgentIdChange={setAgentId} onBack={() => setView({ kind: "arcade" })} />}
    </section>
  );
}

export const playPage = defineConsolePage({
  id: "play", title: "Play", icon: "🎮", order: 35,
  phase: "build", category: "setup",
  route: "#/play",
  component: ({ apiBase }) => <Play apiBase={apiBase} />,
});

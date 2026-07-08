// packages/console/src/panels/Play/index.tsx
import { useEffect, useMemo, useState } from "react";
import { defineConsolePage } from "../../contract.js";
import { discoveredAgentsFromSessions, mergeRunnableAndDiscoveredAgents, preferredAgentId, type DiscoveredPlayAgent, type PlayAgent } from "./AgentSelector.js";
import { fetchSessions } from "../Watch/watchStream.js";
import { Arcade } from "./Arcade.js";
import { Composer } from "./Composer.js";
import { Studio } from "./Studio.js";

type View =
  | { kind: "arcade" }
  | { kind: "composer"; title?: string; prompt?: string }
  | { kind: "studio"; name: string; seedPrompt?: string };
const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };

export function Play({ apiBase }: { apiBase: string }) {
  const [view, setView] = useState<View>({ kind: "arcade" });
  const [agents, setAgents] = useState<PlayAgent[] | null>(null);
  const [discoveredAgents, setDiscoveredAgents] = useState<DiscoveredPlayAgent[]>([]);
  const [agentId, setAgentId] = useState("");

  useEffect(() => {
    fetch(`${apiBase}/api/agents`).then(j).then((data: { agents: PlayAgent[] }) => {
      setAgents(data.agents);
    }).catch(() => setAgents([]));
  }, [apiBase]);

  // Deep-link entry (the marketplace "Make your own" link on a published mini-game):
  // "#/play?new=1&title=<t>&prompt=<p>" opens the Composer with the Blank tab prefilled, so the
  // reader lands ready to hit Create. Hash-reactive, not mount-only — a second "Make your own"
  // click while this tab is already open must still re-seed. Absent `new`, this is a no-op.
  useEffect(() => {
    const applyDeepLink = () => {
      const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
      if (!params.get("new")) return;
      setView({ kind: "composer", title: params.get("title") ?? undefined, prompt: params.get("prompt") ?? undefined });
    };
    applyDeepLink();
    window.addEventListener("hashchange", applyDeepLink);
    return () => window.removeEventListener("hashchange", applyDeepLink);
  }, []);

  useEffect(() => {
    fetchSessions(apiBase).then((sessions) => {
      setDiscoveredAgents(discoveredAgentsFromSessions(sessions));
    }).catch(() => setDiscoveredAgents([]));
  }, [apiBase]);

  const agentOptions = useMemo(
    () => mergeRunnableAndDiscoveredAgents(agents ?? [], discoveredAgents),
    [agents, discoveredAgents],
  );
  const selectorAgents = agents === null && discoveredAgents.length === 0 ? null : agentOptions;

  // Selection lives here, not in the /api/agents fetch: a discovered agent can arrive later,
  // and an agent that stops being runnable must not stay selected.
  useEffect(() => {
    if (selectorAgents === null) return;
    if (agentId && selectorAgents.some((a) => a.id === agentId && a.available)) return;
    const next = preferredAgentId(selectorAgents);
    if (next !== agentId) setAgentId(next);
  }, [agentId, selectorAgents]);

  return (
    <section className="analyze">
      {view.kind !== "studio" && (
        <div className="play-tabs">
          <button className={`play-tab${view.kind === "arcade" ? " is-active" : ""}`} onClick={() => setView({ kind: "arcade" })}>Arcade</button>
          <button className={`play-tab play-tab--cta${view.kind === "composer" ? " is-active" : ""}`} onClick={() => setView({ kind: "composer" })}>+ New miniapp</button>
        </div>
      )}
      {view.kind === "arcade" && <Arcade apiBase={apiBase} onOpen={(name) => setView({ kind: "studio", name })} />}
      {/* keyed on the seed so a fresh deep-link remounts the Composer — its prefill is useState-initial. */}
      {view.kind === "composer" && <Composer key={`${view.title ?? ""}|${view.prompt ?? ""}`} apiBase={apiBase} agents={selectorAgents} agentId={agentId} onAgentIdChange={setAgentId} initialTitle={view.title} initialPrompt={view.prompt} onCreated={(name, seedPrompt) => setView({ kind: "studio", name, seedPrompt })} />}
      {view.kind === "studio" && <Studio apiBase={apiBase} name={view.name} seedPrompt={view.seedPrompt} agents={selectorAgents} agentId={agentId} onAgentIdChange={setAgentId} onBack={() => setView({ kind: "arcade" })} />}
    </section>
  );
}

export const playPage = defineConsolePage({
  id: "play", title: "Play", icon: "🎮", order: 35,
  phase: "build", category: "setup",
  route: "#/play",
  component: ({ apiBase }) => <Play apiBase={apiBase} />,
});

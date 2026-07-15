import { useEffect, useState } from "react";
import {
  AGENT_TASK_FAMILIES, agentTaskSettingsRoute, setAgentTaskSettingRoute, makeClient,
  type AgentTaskFamily, type AgentTaskSettings,
} from "../../api/routes.js";
import { Loading } from "../../shell/Loading.js";

type AgentInfo = { id: string; name: string; available: boolean };

const FAMILY_LABEL: Record<AgentTaskFamily, string> = {
  report: "Report rendering",
  distill: "Skill distillation",
  recommend: "Workflow recommendations",
  judge: "Session judging",
};
const MODEL_OPTIONS = [
  { value: "claude-haiku-4-5", label: "Fast — Haiku 4.5 (default)" },
  { value: "claude-sonnet-5", label: "Balanced — Sonnet" },
  { value: "default", label: "Interactive default" },
];

/** Per-task-family agent + model defaults for background agent tasks. Each change
 *  round-trips through the server (Contribute.tsx pattern); the model select is
 *  disabled for non-Claude agents (no model override mechanism there yet). */
export function AgentTasks({ apiBase }: { apiBase: string }) {
  const [settings, setSettings] = useState<AgentTaskSettings | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    agentTaskSettingsRoute.call(makeClient(apiBase))
      .then((r) => { if (alive) setSettings(r); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    fetch(`${apiBase}/api/agents`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { agents: AgentInfo[] }) => { if (alive) setAgents(d.agents); })
      .catch(() => { /* agent list is cosmetic — selects still render the stored value */ });
    return () => { alive = false; };
  }, [apiBase]);

  const update = async (family: AgentTaskFamily, agent: string, model: string) => {
    setError(null);
    try {
      const r = await setAgentTaskSettingRoute.call(makeClient(apiBase), { body: { family, agent, model } });
      setSettings(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (error && !settings) return <p className="ledger-error" role="alert">{error}</p>;
  if (!settings) return <Loading />;

  return (
    <>
      {AGENT_TASK_FAMILIES.map((family) => {
        const pref = settings.families[family];
        const agentKnown = agents.some((a) => a.id === pref.agent);
        const modelKnown = MODEL_OPTIONS.some((o) => o.value === pref.model);
        return (
          <div className="ledger-bar" key={family}>
            <span className="targets-label">{FAMILY_LABEL[family]}</span>
            <select
              className="targets-select"
              aria-label={`${FAMILY_LABEL[family]} agent`}
              value={pref.agent}
              onChange={(e) => void update(family, e.target.value, pref.model)}
            >
              {!agentKnown && <option value={pref.agent}>{pref.agent}</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.available}>
                  {a.name}{a.available ? "" : " (not installed)"}
                </option>
              ))}
            </select>
            <select
              className="targets-select"
              aria-label={`${FAMILY_LABEL[family]} model`}
              value={pref.model}
              disabled={pref.agent !== "claude-code"}
              onChange={(e) => void update(family, pref.agent, e.target.value)}
            >
              {!modelKnown && <option value={pref.model}>{pref.model}</option>}
              {MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {pref.agent !== "claude-code" && <span className="ws-note">model follows that agent's own default</span>}
          </div>
        );
      })}
      {error && settings && <p className="ledger-error" role="alert">{error}</p>}
    </>
  );
}

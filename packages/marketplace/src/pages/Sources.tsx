import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { CuratedSource, SourceDivision, SourceAgentRef } from "../types";

export function Sources({ api }: { api: ReturnType<typeof makeApi> }) {
  const [sources, setSources] = useState<CuratedSource[] | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [divisions, setDivisions] = useState<SourceDivision[] | null>(null);
  const [division, setDivision] = useState("");
  const [agents, setAgents] = useState<SourceAgentRef[] | null>(null);
  const [skill, setSkill] = useState<{ path: string; content: string } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSources().then((s) => { setSources(s); setSourceId((id) => id || s[0]?.id || ""); }).catch((e) => setError(String(e)));
  }, [api]);

  useEffect(() => {
    if (!sourceId) return;
    setDivisions(null); setDivision(""); setAgents(null); setSkill(null);
    api.getSourceDivisions(sourceId).then(setDivisions).catch((e) => setError(String(e)));
  }, [api, sourceId]);

  useEffect(() => {
    if (!sourceId || !division) return;
    setAgents(null); setSkill(null);
    api.getSourceAgents(sourceId, division).then(setAgents).catch((e) => setError(String(e)));
  }, [api, sourceId, division]);

  const viewSkill = async (a: SourceAgentRef) => {
    if (skill?.path === a.path) { setSkill(null); return; }
    setError(null); setLoading(a.path);
    try {
      const art = await api.importSourceSkill(sourceId, a.path);
      setSkill({ path: a.path, content: art.content });
    } catch (e) { setError(String(e)); } finally { setLoading(null); }
  };

  const source = sources?.find((s) => s.id === sourceId);
  if (!sources && !error) return <p className="ex-empty">Loading…</p>;

  return (
    <div className="ex-sources">
      {source && (
        <p className="ex-source-head">
          {source.description}
          {source.license && <span className="ex-chip"> {source.license}</span>}
          {source.homepage && <> · <a href={source.homepage} target="_blank" rel="noreferrer">{source.repo}</a></>}
        </p>
      )}
      {error && <p className="ex-error">{error}</p>}
      {divisions && (
        <div className="ex-divisions">
          {divisions.map((d) => (
            <button type="button" key={d.key} className={"ex-chip" + (division === d.key ? " is-active" : "")} onClick={() => setDivision(d.key)}>{d.label}</button>
          ))}
        </div>
      )}
      {agents && (
        <ul className="ex-agent-list">
          {agents.map((a) => (
            <li className="ex-agent" key={a.path}>
              <div className="ex-agent-head">
                <span className="ex-agent-name">{a.name}</span>
                <button type="button" className="ex-btn" disabled={loading === a.path} onClick={() => void viewSkill(a)}>
                  {loading === a.path ? "Loading…" : skill?.path === a.path ? "Hide skill" : "View skill"}
                </button>
              </div>
              <code className="ex-install-cmd">agentgem sources install {sourceId} {a.path}</code>
              {skill?.path === a.path && (
                <pre className="ex-skill-body" aria-label={`${a.name} SKILL.md`}>{skill.content}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

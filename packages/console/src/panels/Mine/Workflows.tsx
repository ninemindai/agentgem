import { useState, useRef } from "react";
import type { Scorecard, ProjectGoldmine, WorkflowDetail } from "../../api/routes.js";
import { scorecardWorkflowRoute, makeClient } from "../../api/routes.js";
import type { WorkflowFilter } from "./Scorecard.js";
import { drawWorkflowCard, drawGemCard, shareCanvas } from "./shareCard.js";

type WorkflowEntry = ProjectGoldmine["workflows"][number];

export function MineWorkflows({ data, filter, onFilter, onBuild, building, result, error, apiBase }: {
  data: Scorecard;
  filter: WorkflowFilter;
  onFilter: (f: WorkflowFilter) => void;
  onBuild: (selections: { root: string; keys: string[] }[], name: string) => void;
  building: boolean;
  result: { name: string; skills: string[] } | null;
  error: string | null;
  apiBase: string;
}) {
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [name, setName] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, WorkflowDetail>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});
  const [detailError, setDetailError] = useState<Record<string, string>>({});
  const shareCanvasRef = useRef<HTMLCanvasElement>(null);

  const toggle = (root: string, key: string) => setSelected((s) => {
    const set = new Set(s[root] ?? []);
    set.has(key) ? set.delete(key) : set.add(key);
    return { ...s, [root]: set };
  });

  const toggleExpand = (root: string, key: string) => {
    const cacheKey = `${root}:${key}`;
    const isOpen = expanded[cacheKey];
    setExpanded((e) => ({ ...e, [cacheKey]: !isOpen }));
    if (!isOpen && !details[cacheKey] && !detailLoading[cacheKey]) {
      setDetailLoading((l) => ({ ...l, [cacheKey]: true }));
      scorecardWorkflowRoute.call(makeClient(apiBase), { query: { root, key } })
        .then((d) => {
          setDetails((prev) => ({ ...prev, [cacheKey]: d }));
          setDetailError((prev) => { const next = { ...prev }; delete next[cacheKey]; return next; });
        })
        .catch((e: unknown) => {
          setDetailError((prev) => ({ ...prev, [cacheKey]: e instanceof Error ? e.message : "Failed to load detail" }));
        })
        .finally(() => {
          setDetailLoading((l) => { const next = { ...l }; delete next[cacheKey]; return next; });
        });
    }
  };

  const toggleFilter = (f: WorkflowFilter) => onFilter(filter === f ? "all" : f);

  const shareWorkflow = async (root: string, key: string, wfName: string) => {
    const cacheKey = `${root}:${key}`;
    let detail = details[cacheKey];
    if (!detail) {
      try {
        detail = await scorecardWorkflowRoute.call(makeClient(apiBase), { query: { root, key } });
        setDetails((prev) => ({ ...prev, [cacheKey]: detail! }));
      } catch {
        return;
      }
    }
    const c = shareCanvasRef.current;
    if (!c) return;
    drawWorkflowCard(c, detail);
    void shareCanvas(c, `${wfName}.png`, wfName);
  };

  const shareGem = () => {
    if (!result) return;
    const c = shareCanvasRef.current;
    if (!c) return;
    drawGemCard(c, result);
    void shareCanvas(c, `${result.name}.png`, result.name);
  };

  const match = (w: WorkflowEntry) => filter === "all" || (filter === "battleTested" ? w.confidence === "high" : w.portable);
  const visibleProjects = data.projects
    .map((p) => ({ ...p, workflows: p.workflows.filter(match) }))
    .filter((p) => p.workflows.length);

  // Build a set of visible keys per root for stale-selection detection
  const visibleKeys: Record<string, Set<string>> = {};
  for (const p of visibleProjects) {
    visibleKeys[p.root] = new Set(p.workflows.map((w) => w.key));
  }

  const selections = Object.entries(selected)
    .map(([root, set]) => ({ root, keys: [...set] }))
    .filter((x) => x.keys.length);
  const count = selections.reduce((n, s) => n + s.keys.length, 0);

  // Count selected keys hidden by the current filter
  const hiddenCount = Object.entries(selected).reduce((acc, [root, set]) => {
    const visible = visibleKeys[root] ?? new Set();
    for (const key of set) {
      if (!visible.has(key)) acc++;
    }
    return acc;
  }, 0);

  return (
    <section className="mine-workflows" aria-label="Discovered workflows">
      <h3>Pick workflows to distill into a Gem</h3>
      <div className="mine-filter-bar">
        <button
          className={filter === "all" ? "is-active" : ""}
          aria-pressed={filter === "all"}
          onClick={() => onFilter("all")}
        >All</button>
        <button
          className={filter === "battleTested" ? "is-active" : ""}
          aria-pressed={filter === "battleTested"}
          onClick={() => toggleFilter("battleTested")}
        >Battle-tested ({data.battleTested})</button>
        <button
          className={filter === "portable" ? "is-active" : ""}
          aria-pressed={filter === "portable"}
          onClick={() => toggleFilter("portable")}
        >Worth sharing ({data.portable})</button>
      </div>
      {visibleProjects.map((p) => (
        <div className="mine-project" key={p.root}>
          <div className="mine-project-label">{p.label}</div>
          <ul className="mine-wf-list">
            {p.workflows.map((w) => {
              const cacheKey = `${p.root}:${w.key}`;
              return (
              <li key={w.key}>
                <label>
                  <input type="checkbox" aria-label={w.name} checked={selected[p.root]?.has(w.key) ?? false} onChange={() => toggle(p.root, w.key)} />
                </label>
                <button
                  className="mine-wf-view"
                  aria-label={expanded[cacheKey] ? "Collapse detail" : "Expand detail"}
                  onClick={() => toggleExpand(p.root, w.key)}
                >{expanded[cacheKey] ? "▾" : "▸"}</button>
                <span className="mine-wf-name">{w.name}</span>
                {w.confidence === "high" && <span className="mine-badge mine-badge-bt">battle-tested</span>}
                {w.portable && <span className="mine-badge mine-badge-portable">portable</span>}
                <button
                  className="mine-wf-share"
                  aria-label={`Share ${w.name}`}
                  onClick={() => void shareWorkflow(p.root, w.key, w.name)}
                >Share</button>
                {expanded[cacheKey] && (
                  <div className="mine-wf-detail">
                    {detailLoading[cacheKey] && <span>Loading…</span>}
                    {detailError[cacheKey] && <span className="obs-error">{detailError[cacheKey]}</span>}
                    {details[cacheKey] && (() => {
                      const d = details[cacheKey];
                      return (
                        <>
                          {d.description && <p>{d.description}</p>}
                          {d.triggers.length > 0 && <p><strong>Triggers:</strong> {d.triggers.join(", ")}</p>}
                          {d.tools.length > 0 && <p><strong>Tools:</strong> {d.tools.join(", ")}</p>}
                          {d.steps.length > 0 && (
                            <ol className="steps">
                              {d.steps.map((step, i) => <li key={i}>{step}</li>)}
                            </ol>
                          )}
                          <p className="mine-wf-sessions">from {d.sessions} session{d.sessions === 1 ? "" : "s"}</p>
                        </>
                      );
                    })()}
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="mine-build-bar">
        <input
          className="mine-gem-name"
          placeholder="gem name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="scorecard-share"
          disabled={!count || building}
          onClick={() => onBuild(selections, name.trim() || "goldmine-gem")}
        >
          {building ? "Building…" : `Build Gem${count ? ` (${count})` : ""}`}
        </button>
        {hiddenCount > 0 && <span className="mine-hidden-note">({hiddenCount} selected hidden by filter)</span>}
      </div>
      {result && (
        <p className="mine-build-ok">
          ✓ Built <strong>{result.name}</strong> — {result.skills.length} skill{result.skills.length === 1 ? "" : "s"}: {result.skills.join(", ")}
          {" "}<button className="mine-wf-share" aria-label={`Share ${result.name} gem`} onClick={shareGem}>Share gem</button>
        </p>
      )}
      {error && <p className="obs-error">{error}</p>}
      <canvas ref={shareCanvasRef} style={{ display: "none" }} />
    </section>
  );
}

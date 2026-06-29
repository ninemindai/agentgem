import { useState } from "react";
import type { Scorecard, ProjectGoldmine } from "../../api/routes.js";
import type { WorkflowFilter } from "./Scorecard.js";

type WorkflowEntry = ProjectGoldmine["workflows"][number];

export function MineWorkflows({ data, filter, onBuild, building, result, error }: {
  data: Scorecard;
  filter: WorkflowFilter;
  onBuild: (selections: { root: string; keys: string[] }[], name: string) => void;
  building: boolean;
  result: { name: string; skills: string[] } | null;
  error: string | null;
}) {
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [name, setName] = useState("");

  const toggle = (root: string, key: string) => setSelected((s) => {
    const set = new Set(s[root] ?? []);
    set.has(key) ? set.delete(key) : set.add(key);
    return { ...s, [root]: set };
  });

  const match = (w: WorkflowEntry) => filter === "all" || (filter === "battleTested" ? w.confidence === "high" : w.portable);
  const visibleProjects = data.projects
    .map((p) => ({ ...p, workflows: p.workflows.filter(match) }))
    .filter((p) => p.workflows.length);

  const selections = Object.entries(selected)
    .map(([root, set]) => ({ root, keys: [...set] }))
    .filter((x) => x.keys.length);
  const count = selections.reduce((n, s) => n + s.keys.length, 0);

  return (
    <section className="mine-workflows" aria-label="Discovered workflows">
      <h3>Pick workflows to distill into a Gem</h3>
      {visibleProjects.map((p) => (
        <div className="mine-project" key={p.root}>
          <div className="mine-project-label">{p.label}</div>
          <ul className="mine-wf-list">
            {p.workflows.map((w) => (
              <li key={w.key}>
                <label>
                  <input type="checkbox" checked={selected[p.root]?.has(w.key) ?? false} onChange={() => toggle(p.root, w.key)} />
                  <span className="mine-wf-name">{w.name}</span>
                  {w.confidence === "high" && <span className="mine-badge mine-badge-bt">battle-tested</span>}
                  {w.portable && <span className="mine-badge mine-badge-portable">portable</span>}
                </label>
              </li>
            ))}
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
      </div>
      {result && (
        <p className="mine-build-ok">
          ✓ Built <strong>{result.name}</strong> — {result.skills.length} skill{result.skills.length === 1 ? "" : "s"}: {result.skills.join(", ")}
        </p>
      )}
      {error && <p className="obs-error">{error}</p>}
    </section>
  );
}

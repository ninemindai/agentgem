import { useEffect, useRef, useState } from "react";
import {
  rubricsRoute, validateRubricRoute, saveRubricRoute, deleteRubricRoute,
  makeClient, type RubricSummary, type RubricValidation,
} from "../../api/routes.js";
import { defineConsolePage } from "../../registry.js";
import { setPendingRubricRun } from "../../pendingAnalyze.js";
import { Loading } from "../../shell/Loading.js";
import { useSplit } from "../../shell/useSplit.js";
import { getKeys, setKeys } from "../../activeGem.js";
import { selKey } from "../Curate/selection.js";

function isCheap(r: RubricSummary): boolean {
  return !r.criteria || r.criteria.length === 0;
}

// Group rubrics by the scope they're designed for (design §5c).
const SCOPE_GROUPS: { key: string; label: string; match: (r: RubricSummary) => boolean }[] = [
  { key: "session", label: "Session lenses", match: (r) => r.naturalScope === "session" },
  { key: "project", label: "Project lenses", match: (r) => r.naturalScope === "project" },
  { key: "all", label: "Corpus lenses", match: (r) => r.naturalScope === "all" },
  { key: "other", label: "Other", match: (r) => !r.naturalScope },
];

const TEMPLATE = JSON.stringify({
  id: "my-rubric", title: "My rubric", target: "overview", naturalScope: "project",
  factors: [{ factor: "no-verify-finish" }],
}, null, 2);

function runRubric(id: string): void {
  setPendingRubricRun({ rubric: id });
  window.location.hash = "#/rubrics";
}

/** Add a rubric to the active gem selection (additive) and return the curate route to navigate to. */
export function bundleRubric(rubricId: string): string {
  setKeys(new Set([...getKeys(), selKey("rubrics", rubricId)]));
  return "#/curate";
}

// The validated JSON editor: live server-side validation with a resolved-factors preview.
function RubricEditor({ apiBase, initial, onClose, onSaved }: { apiBase: string; initial: string; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(initial);
  const [parseError, setParseError] = useState<string | null>(null);
  const [check, setCheck] = useState<RubricValidation | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const split = useSplit("rubric", { initial: 240, min: 200, max: 420, side: "end" });

  // Debounced parse → server validate, so the preview tracks what you type.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      let obj: unknown;
      try { obj = JSON.parse(text); } catch (e) { setParseError(e instanceof Error ? e.message : "invalid JSON"); setCheck(null); return; }
      setParseError(null);
      validateRubricRoute.call(makeClient(apiBase), { body: obj as Record<string, unknown> })
        .then(setCheck).catch(() => setCheck({ valid: false, error: "validation request failed" }));
    }, 400);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [text, apiBase]);

  const save = async () => {
    let obj: unknown;
    try { obj = JSON.parse(text); } catch { return; }
    setSaving(true);
    try {
      const r = await saveRubricRoute.call(makeClient(apiBase), { body: obj as Record<string, unknown> });
      if (r.saved) onSaved(); else setCheck(r);
    } finally { setSaving(false); }
  };

  const canSave = !parseError && check?.valid && !saving;
  return (
    <div
      className={"rub-editor" + (split.containerProps.className ? " " + split.containerProps.className : "")}
      style={split.containerProps.style}
    >
      <textarea className="rub-editor-text" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} rows={16} aria-label="rubric JSON" />
      {split.handle}
      <div className="rub-editor-side">
        {parseError && <p className="ledger-error">JSON: {parseError}</p>}
        {!parseError && check && !check.valid && <p className="ledger-error">{check.error}</p>}
        {!parseError && check?.valid && (
          <>
            <p className="rub-editor-ok">✓ valid</p>
            <p className="rub-lib-heading">Resolves to</p>
            <ul className="rub-lib-factors">
              {check.factors?.map((f) => (
                <li key={f.factor}><code>{f.factor}</code> <span className={"rub-kind rub-kind-" + f.kind}>{f.kind}</span></li>
              ))}
            </ul>
            {check.unknownFactors && check.unknownFactors.length > 0 && (
              <p className="insights-hint">Unknown factor{check.unknownFactors.length === 1 ? "" : "s"} will be skipped at run: {check.unknownFactors.join(", ")}.</p>
            )}
          </>
        )}
        <div className="rub-editor-actions">
          <button type="button" className="ledger-view" disabled={!canSave} onClick={save}>{saving ? "Saving…" : "Save"}</button>
          <button type="button" className="ledger-view" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function RubricRow({ apiBase, r, onChanged }: { apiBase: string; r: RubricSummary; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  const del = async () => {
    if (!window.confirm(`Delete rubric "${r.id}"?`)) return;
    await deleteRubricRoute.call(makeClient(apiBase), { body: { id: r.id } });
    onChanged();
  };

  return (
    <li className="analyze-row">
      <div className="analyze-row-head">
        <button type="button" className="rub-lib-name" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="rub-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span className="analyze-name">{r.title}</span>
        </button>
        <span className="targets-label">{r.factors.length} factor{r.factors.length === 1 ? "" : "s"}</span>
        <span className="ws-chip" title={isCheap(r) ? "Runs pattern checks — instant, deterministic" : "Uses LLM criteria — drives the agent"}>{isCheap(r) ? "cheap" : "LLM"}</span>
        {!r.builtin && <button type="button" className="ledger-view" onClick={() => { setEditing(true); setOpen(true); }}>Edit</button>}
        {!r.builtin && <button type="button" className="ledger-view rub-del" onClick={del}>Delete</button>}
        <button type="button" className="ledger-view" onClick={() => runRubric(r.id)}>Run ▶</button>
        <button type="button" className="ledger-view" onClick={() => { window.location.hash = bundleRubric(r.id); }}>Bundle ▸</button>
      </div>
      {open && !editing && (
        <div className="run-out">
          <ul className="rub-lib-factors">
            {r.factors.map((f) => <li key={f.factor}><code>{f.factor}</code>{f.weight != null && f.weight !== 1 ? ` ×${f.weight}` : ""}</li>)}
          </ul>
          {r.criteria && r.criteria.length > 0 && (
            <p className="ledger-muted">{r.criteria.length} LLM criterion{r.criteria.length === 1 ? "" : "a"} — judged by the agent.</p>
          )}
        </div>
      )}
      {open && editing && (
        <RubricEditor apiBase={apiBase} initial={JSON.stringify(r, null, 2)} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} />
      )}
    </li>
  );
}

/** Rubrics catalog: browse, author (validated JSON editor), and manage the lenses
 *  you can run (built-in + your own), grouped by the scope they're designed for. */
export function RubricLibrary({ apiBase }: { apiBase: string }) {
  const [rubrics, setRubrics] = useState<RubricSummary[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => rubricsRoute.call(makeClient(apiBase)).then((r) => setRubrics(r.rubrics)).catch(() => setRubrics([]));
  useEffect(() => { void load(); }, [apiBase]);

  if (!rubrics) return <section className="analyze"><Loading /></section>;

  return (
    <section className="analyze">
      <div className="rub-lib-top">
        <p className="analyze-intro" style={{ margin: 0 }}>Rubrics are named lenses of checks you run over your sessions. Built-ins work out of the box; author your own below (saved as JSON in <code>~/.agentgem/rubrics/</code>).</p>
        <button type="button" className="ledger-build" onClick={() => setCreating((c) => !c)}>{creating ? "Close" : "+ New rubric"}</button>
      </div>
      {creating && (
        <RubricEditor apiBase={apiBase} initial={TEMPLATE} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void load(); }} />
      )}
      {SCOPE_GROUPS.map((g) => {
        const items = rubrics.filter(g.match);
        if (items.length === 0) return null;
        return (
          <div className="rub-lib-group" key={g.key}>
            <h4 className="rub-lib-heading">{g.label}</h4>
            <ul className="analyze-list">
              {items.map((r) => <RubricRow key={r.id} apiBase={apiBase} r={r} onChanged={() => void load()} />)}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

export const rubricLibraryPage = defineConsolePage({
  id: "rubric-library", title: "Rubrics", icon: "📋", order: 40, phase: "build", category: "setup",
  route: "#/rubric-library", component: RubricLibrary,
});

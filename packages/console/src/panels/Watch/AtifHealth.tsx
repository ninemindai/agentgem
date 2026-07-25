import { useEffect, useState } from "react";
import { fetchAtifHealth, type AtifHealth as Health } from "./watchStream.js";

// One-line human gloss per code so the user knows what to fix. Keys mirror
// AtifDiagnosticCode in @agentgem/insight (kept as a plain map to avoid a
// cross-package type import in the console).
const GLOSS: Record<string, string> = {
  invalid_json: "not valid JSON — the file is corrupt or truncated",
  not_an_object: "valid JSON but not an object — likely wrapped in an array",
  unknown_schema_version: "not an ATIF file — wrong or missing schema_version",
  missing_agent: "no agent block — the converter left it out",
  no_steps: "no steps — an empty session",
  timestamps_missing: "no step timestamps — dated by file mtime instead",
  orphan_tool_result: "tool result with no matching call — a converter bug",
};

const MAX_FILES = 6;

export function AtifHealth({ apiBase, refreshKey }: { apiBase: string; refreshKey?: number }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchAtifHealth(apiBase)
      .then((h) => { if (alive) setHealth(h); })
      .catch(() => { if (alive) setHealth(null); });
    return () => { alive = false; };
  }, [apiBase, refreshKey]);

  if (!health || health.groups.length === 0) return null;

  const problemFiles = new Set(health.groups.flatMap((g) => g.files.map((f) => f.name))).size;
  const anyRejection = health.groups.some((g) => g.rejection);

  return (
    <div className={"watch-atif" + (anyRejection ? " is-rejection" : " is-degraded")}>
      <button type="button" className="watch-atif-summary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="watch-atif-caret">{open ? "▾" : "▸"}</span>
        {" "}ATIF drop-dir · {health.imported}/{health.totalFiles} imported · {problemFiles} with issues
      </button>
      {open && (
        <ul className="watch-atif-groups">
          {health.groups.map((g) => (
            <li key={g.code} className={"watch-atif-group" + (g.rejection ? " is-rejection" : " is-degraded")}>
              <div className="watch-atif-code">
                <span className="watch-atif-mark">{g.rejection ? "✗" : "⚠"}</span>
                {" "}{g.code} — {g.files.length} file{g.files.length === 1 ? "" : "s"}
                {g.occurrences > g.files.length ? `, ${g.occurrences}×` : ""}
                <span className="ws-chip">{g.rejection ? "rejected" : "degraded"}</span>
              </div>
              <div className="watch-atif-gloss">{GLOSS[g.code] ?? g.code}</div>
              <div className="watch-atif-files">
                {g.files.slice(0, MAX_FILES).map((f, i) => (
                  <span key={i} className="watch-atif-file">{f.name}{f.detail ? ` (${f.detail})` : ""}</span>
                ))}
                {g.files.length > MAX_FILES && <span className="watch-atif-more">… (+{g.files.length - MAX_FILES})</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

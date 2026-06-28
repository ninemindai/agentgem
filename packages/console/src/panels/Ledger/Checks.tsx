import type { GemCheck } from "../../api/routes.js";

/** Suggest checks for the selection and choose which to include in the build. */
export function Checks({ suggested, included, busy, error, onSuggest, onToggle }: {
  suggested: GemCheck[] | null;
  included: Set<string>;
  busy: boolean;
  error: string | null;
  onSuggest: () => void;
  onToggle: (name: string) => void;
}) {
  return (
    <div className="checks">
      <div className="checks-bar">
        <span className="targets-label">Checks</span>
        <button type="button" className="ledger-sort" disabled={busy} onClick={onSuggest}>
          {busy ? "Suggesting…" : "Suggest checks"}
        </button>
        {error && <span className="ledger-error">{error}</span>}
      </div>
      {suggested && suggested.length === 0 && <p className="ledger-empty">No checks suggested for this selection.</p>}
      {suggested && suggested.length > 0 && (
        <ul className="checks-list">
          {suggested.map((c) => (
            <li className="checks-item" key={c.name}>
              <label className="ledger-item-main">
                <input type="checkbox" checked={included.has(c.name)} onChange={() => onToggle(c.name)} />
                <span className="checks-kind">{c.kind}</span>
                <span>{c.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

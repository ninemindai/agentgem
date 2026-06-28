import { useState } from "react";
import type { Gem } from "../../api/routes.js";

export interface PreviewActions {
  onDownloadGem?: () => void;
  onDownloadJson?: () => void;
  onCopyJson?: () => void;
}

/** Shows a built gem: a summary (counts + artifact list) with a raw-JSON toggle. */
export function Preview({ gem, onDownloadGem, onDownloadJson, onCopyJson }: { gem: Gem } & PreviewActions) {
  const [json, setJson] = useState(false);
  return (
    <div className="preview">
      <div className="preview-head">
        <strong className="preview-name">{gem.name}</strong>
        <span className="preview-modes">
          <button type="button" className={json ? "" : "is-active"} onClick={() => setJson(false)}>Summary</button>
          <button type="button" className={json ? "is-active" : ""} onClick={() => setJson(true)}>JSON</button>
        </span>
      </div>
      {(onDownloadGem || onDownloadJson || onCopyJson) && (
        <div className="preview-actions">
          {onDownloadGem && <button type="button" className="preview-export primary" onClick={onDownloadGem}>Download .gem</button>}
          {onDownloadJson && <button type="button" className="preview-export" onClick={onDownloadJson}>Download JSON</button>}
          {onCopyJson && <button type="button" className="preview-export" onClick={onCopyJson}>Copy JSON</button>}
        </div>
      )}
      {json ? (
        <pre className="preview-json">{JSON.stringify(gem, null, 2)}</pre>
      ) : (
        <div className="preview-summary">
          <p className="preview-from">from {gem.createdFrom}</p>
          <div className="preview-stats">
            <span className="ws-chip">{gem.artifacts.length} artifacts</span>
            <span className="ws-chip">{gem.checks.length} checks</span>
            <span className="ws-chip">{gem.requiredSecrets.length} secrets</span>
          </div>
          <ul className="preview-artifacts">
            {gem.artifacts.map((a) => (
              <li key={`${a.type}::${a.name}`}>
                <span className="preview-atype">{a.type}</span> {a.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

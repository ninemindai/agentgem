// packages/console/src/panels/Play/UploadsField.tsx
import type { useUploads } from "./uploads.js";

export function UploadsField({ u, compact }: { u: ReturnType<typeof useUploads>; compact?: boolean }) {
  return (
    <div className={compact ? "play-uploads play-uploads--compact" : "play-uploads"}>
      <label
        className={compact ? "play-btn play-attach" : "play-drop"}
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); u.addUploads(e.dataTransfer.files); }}
      >
        {compact ? "📎 Attach files" : <><b>Drop files</b> to seed this miniapp (optional) — or click to choose</>}
        <input data-testid="uploads-input" type="file" multiple onChange={(e) => u.addUploads(e.target.files)} style={{ display: "none" }} />
      </label>
      {u.uploads.length > 0 && (
        <ul className="play-uploads__list">
          {u.uploads.map((f) => (
            <li key={f.name} className="play-uploads__row">
              <span className="play-uploads__name">{f.name}</span>
              <span className="play-uploads__size">{(f.size / 1024).toFixed(0)} KB</span>
              <select data-testid={`role-${f.name}`} className="play-uploads__role" value={f.role} onChange={(e) => u.setRole(f.name, e.target.value as "ship" | "reference")}>
                <option value="ship">Ship</option>
                <option value="reference">Reference</option>
              </select>
              <button type="button" className="play-uploads__x" aria-label={`remove ${f.name}`} onClick={() => u.remove(f.name)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

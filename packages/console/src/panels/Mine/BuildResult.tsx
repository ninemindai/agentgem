// packages/console/src/panels/Mine/BuildResult.tsx
// The "✓ Built" banner for Distill → Gem, with an inline viewer for the distilled
// SKILL.md drafts. The gem is assembled in memory by /api/scorecard/build and never
// persisted (there is no gem stash yet), so this viewer — plus Copy/Download — is
// the only window onto what was built; without it the button is a dead end.
import { useState } from "react";

export type DistilledSkillView = { name: string; description?: string; content?: string };

export function BuildResult({ name, skills }: { name: string; skills: DistilledSkillView[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = skills.find((s) => s.name === open && s.content);
  const download = (s: DistilledSkillView) => {
    const url = URL.createObjectURL(new Blob([s.content ?? ""], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${s.name}-SKILL.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="mine-build-result">
      <p className="mine-build-result__line">
        ✓ Built <strong>{name}</strong> — {skills.length} skill{skills.length === 1 ? "" : "s"}:{" "}
        {skills.map((s, i) => (
          <span key={s.name}>
            {i > 0 && ", "}
            {s.content
              ? (
                <button type="button" className="mine-build-result__skill"
                  onClick={() => setOpen(open === s.name ? null : s.name)}>{s.name}</button>
              )
              : s.name}
          </span>
        ))}
      </p>
      {shown && (
        <div className="mine-build-result__panel">
          <div className="mine-build-result__panel-head">
            <strong>{shown.name}</strong>
            {shown.description && <span className="mine-build-result__desc">{shown.description}</span>}
            <span className="mine-build-result__acts">
              <button type="button" className="gem-card__act"
                onClick={() => { void navigator.clipboard?.writeText(shown.content ?? ""); }}>Copy</button>
              <button type="button" className="gem-card__act" onClick={() => download(shown)}>Download</button>
            </span>
          </div>
          <pre className="mine-build-result__md">{shown.content}</pre>
        </div>
      )}
    </div>
  );
}

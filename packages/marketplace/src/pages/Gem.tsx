import { getGem } from "../gems/catalog";
import { prettifyId, kindLabel } from "../data";

export function Gem({ keyName }: { keyName: string }) {
  const gem = getGem(keyName);
  if (!gem) {
    return <div className="ex-gem-detail"><p className="ex-empty">Gem not found: "{keyName}".</p></div>;
  }

  const copyKey = () => { void navigator.clipboard?.writeText(gem.key); };

  return (
    <div className="ex-gem-detail">
      <h2 className="ex-gem-title">
        {gem.key} <span className="ex-gem-version">v{gem.version}</span>
      </h2>
      <p className="ex-gem-meta">
        {gem.author && <span>by {gem.author}</span>}
        {gem.artifactKinds.map((k) => <span key={k} className="ex-chip">{kindLabel(k)}</span>)}
      </p>
      <p className="ex-gem-desc">{gem.description}</p>
      <p className="ex-gem-tags">{gem.tags.map((t) => <span key={t} className="ex-tag">#{t}</span>)}</p>

      <section className="ex-card">
        <h3>Get this gem</h3>
        <p className="ex-getit">
          Gem key: <code className="ex-key">{gem.key}</code>
          <button type="button" className="ex-copy" onClick={copyKey} aria-label="copy gem key">Copy key</button>
        </p>
        <p className="ex-getit-steps">Open the AgentGem desktop console → <strong>Get Gems</strong> → search "{gem.key}" → <strong>Install</strong>.</p>
      </section>

      <section className="ex-card">
        <h3>Contains</h3>
        <ul className="ex-ingredients">
          {gem.ingredients.map((ing) => {
            const p = prettifyId(ing.id, ing.kind);
            return (
              <li key={ing.id}>
                <a href={"/ingredient/" + encodeURIComponent(ing.id)} title={ing.id}>
                  {p.name}
                </a>
                <span className="ex-chip">{kindLabel(ing.kind)}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

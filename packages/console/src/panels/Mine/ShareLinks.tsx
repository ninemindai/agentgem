import { useState } from "react";
import { shareIntents } from "./shareIntents.js";

// `url` absent = pending: the row renders immediately in a disabled state (placeholder input,
// disabled copy, inert intent chips) and fades to active once the hosted link resolves.
export function ShareLinks({ url }: { url?: string }) {
  const [copied, setCopied] = useState(false);
  const pending = !url;
  const intents = url ? shareIntents(url) : null;
  const copy = () => { if (!url) return; void navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return (
    <div className={`scorecard-share-links${pending ? " is-pending" : ""}`} aria-busy={pending}>
      <div className="scorecard-share-copy">
        <input readOnly value={url ?? ""} placeholder="Creating link…" aria-label="Share link" disabled={pending} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="is-copy" onClick={copy} disabled={pending}>{copied ? "Copied" : "Copy link"}</button>
      </div>
      <div className="scorecard-share-intents">
        <span className="scorecard-share-on">Share to</span>
        {intents ? (
          <>
            <a className="scorecard-intent" href={intents.x} target="_blank" rel="noreferrer">X</a>
            <a className="scorecard-intent" href={intents.linkedin} target="_blank" rel="noreferrer">LinkedIn</a>
            <a className="scorecard-intent" href={intents.facebook} target="_blank" rel="noreferrer">Facebook</a>
          </>
        ) : (
          <>
            <span className="scorecard-intent is-disabled" aria-disabled="true">X</span>
            <span className="scorecard-intent is-disabled" aria-disabled="true">LinkedIn</span>
            <span className="scorecard-intent is-disabled" aria-disabled="true">Facebook</span>
          </>
        )}
      </div>
    </div>
  );
}

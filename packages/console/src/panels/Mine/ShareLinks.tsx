import { useState } from "react";
import { shareIntents } from "./shareIntents.js";

export function ShareLinks({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const intents = shareIntents(url);
  const copy = () => { void navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return (
    <div className="scorecard-share-links">
      <div className="scorecard-share-copy">
        <input readOnly value={url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="is-copy" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
      </div>
      <div className="scorecard-share-intents">
        <span className="scorecard-share-on">Share to</span>
        <a className="scorecard-intent" href={intents.x} target="_blank" rel="noreferrer">X</a>
        <a className="scorecard-intent" href={intents.linkedin} target="_blank" rel="noreferrer">LinkedIn</a>
        <a className="scorecard-intent" href={intents.facebook} target="_blank" rel="noreferrer">Facebook</a>
      </div>
    </div>
  );
}

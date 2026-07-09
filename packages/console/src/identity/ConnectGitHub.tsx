// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Chrome-free device-flow UI. Studio renders it as an inline banner; IdentityChip
// renders it inside ConnectGitHubModal. Button labels are asserted by
// Settings.test.tsx and PublishToExplore.test.tsx — do not reword them.
import type { ReactElement, ReactNode } from "react";
import type { GitHubBind } from "./useGitHubBind.js";

export function ConnectGitHub({
  bind,
  idleHint,
  idleLabel = "Connect GitHub",
}: {
  bind: GitHubBind;
  idleHint?: ReactNode;
  idleLabel?: string;
}): ReactElement {
  const { flow, unconfigured, connectBusy, polling, codeCopied, error, connect, copyOpenAndWait } = bind;

  return (
    <div className="identity-connect">
      {error && <p className="identity-connect__error">{error}</p>}

      {unconfigured ? (
        <p className="deploy-hint">Verification unavailable (not configured)</p>
      ) : flow ? (
        <>
          <p className="ws-note">Your code: <strong>{flow.userCode}</strong></p>
          <button type="button" className="ledger-build" onClick={() => void copyOpenAndWait()} disabled={polling}>
            {polling ? "Waiting for authorization…" : codeCopied ? "✓ Copied — opening GitHub…" : "⧉ Copy code & open GitHub"}
          </button>
          <p className="deploy-hint">
            Copies the code and opens GitHub in your browser — enter it there and authorize; this verifies automatically.
            {" "}Didn't open? <a href={flow.openUrl} target="_blank" rel="noreferrer">Open GitHub</a>.
          </p>
        </>
      ) : (
        <>
          <button type="button" className="ledger-build" onClick={() => void connect()} disabled={connectBusy}>
            {connectBusy ? "Generating code…" : idleLabel}
          </button>
          {idleHint}
        </>
      )}
    </div>
  );
}

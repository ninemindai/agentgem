// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Modal chrome around ConnectGitHub, for signing in from the shell's identity chip.
// Owns its own classes: Setup's `setup-modal` styles are panel-local and renaming
// them there must not silently break the chip.
import { useEffect, type ReactElement } from "react";
import { ConnectGitHub } from "./ConnectGitHub.js";
import type { GitHubBind } from "./useGitHubBind.js";

export function ConnectGitHubModal({
  bind,
  onClose,
  title = "Connect GitHub",
}: {
  bind: GitHubBind;
  onClose: () => void;
  title?: string;
}): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="identity-modal" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="identity-modal__panel" onClick={(e) => e.stopPropagation()}>
        <div className="identity-modal__head">
          <strong>{title}</strong>
          <button type="button" className="identity-modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="identity-modal__body">
          <ConnectGitHub
            bind={bind}
            idleLabel="Sign in with GitHub"
            idleHint={<p className="deploy-hint">Signs you in here and on app.agentgem.ai.</p>}
          />
        </div>
      </div>
    </div>
  );
}

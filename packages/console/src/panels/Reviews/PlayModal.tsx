// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Sealed-play modal for the Reviews inbox "Play to test" action: wraps the standalone Runner
// player over a staged game's html. Broker-less on purpose (no apiBase/name/needs) — a staged
// gem under review must not be able to reach the MCP-Apps capability broker.
import { type ReactElement } from "react";
import { useDialogA11y } from "../../shell/useDialogA11y.js";
import { Runner } from "../Play/Runner.js";

export function PlayModal({
  html, gemKey, version, onClose,
}: { html: string; gemKey: string; version: string; onClose: () => void }): ReactElement {
  const panelRef = useDialogA11y(onClose);
  const title = `Playing ${gemKey}@${version} — staged for review`;

  return (
    <div className="identity-modal" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="identity-modal__panel" ref={panelRef} onClick={(e) => e.stopPropagation()}>
        <div className="identity-modal__head">
          <strong>{title}</strong>
          <button type="button" className="identity-modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="identity-modal__body">
          <Runner html={html} interactive maxHeight={520} />
        </div>
      </div>
    </div>
  );
}

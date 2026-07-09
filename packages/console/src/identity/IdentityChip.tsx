// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The console's identity affordance. Signed in, it mints a one-time handoff code and
// opens app.agentgem.ai already authenticated (desktop: main.ts routes window.open to
// the system browser). Otherwise it opens the device-flow modal.
import { useState, type ReactElement } from "react";
import { webHandoffRoute, makeClient } from "../api/routes.js";
import { useIdentity } from "./IdentityProvider.js";
import { useGitHubBind } from "./useGitHubBind.js";
import { ConnectGitHubModal } from "./ConnectGitHubModal.js";

export function IdentityChip({ apiBase }: { apiBase: string }): ReactElement | null {
  const { status, refresh } = useIdentity();
  const [open, setOpen] = useState(false);
  // Closing the modal on success is the natural end of the flow.
  const bind = useGitHubBind(apiBase, { onBound: () => setOpen(false) });

  // Abandon the device code on close: reopening mints a fresh one rather than
  // resuming a code that may have expired against GitHub in the meantime.
  const close = () => { setOpen(false); bind.reset(); };

  if (status === null) return null; // first fetch in flight — don't flash "Sign in"

  const openOnWeb = async () => {
    try {
      const r = await webHandoffRoute.call(makeClient(apiBase), { body: {} });
      if (r.authenticated && r.url) { window.open(r.url, "_blank", "noopener"); return; }
    } catch {
      /* fall through to the connect modal — a dead session is the likely cause */
    }
    // The server clears the dead session on its own 401, so reconnecting is the fix.
    await refresh();
    setOpen(true);
  };

  const onClick = () => {
    if (status.bound && status.sessionActive) { void openOnWeb(); return; }
    setOpen(true);
  };

  const label = status.bound ? `@${status.login}` : "Sign in";
  const title = status.bound
    ? status.sessionActive ? "Open app.agentgem.ai signed in" : "Session expired — reconnect GitHub"
    : "Sign in with GitHub";

  return (
    <>
      <button
        type="button"
        className={"identity-chip" + (status.bound && !status.sessionActive ? " is-stale" : "")}
        onClick={onClick}
        title={title}
      >
        {status.avatarUrl
          ? <img className="identity-chip__avatar" src={status.avatarUrl} alt={`@${status.login}`} width={20} height={20} />
          : <span className="identity-chip__avatar identity-chip__avatar--empty" aria-hidden="true" />}
        <span className="identity-chip__label">{label}</span>
        {status.bound && status.sessionActive && <span className="identity-chip__ext" aria-hidden="true">↗</span>}
      </button>
      {open && <ConnectGitHubModal bind={bind} onClose={close} />}
    </>
  );
}

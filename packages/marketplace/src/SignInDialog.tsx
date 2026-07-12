// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { Modal } from "./Modal";

/** The sign-in chooser: one entry per provider plus an optional passkey entry. Presentational —
 *  all effects (OAuth redirect, WebAuthn ceremony) live in the parent so this stays testable. */
export function SignInDialog({ onClose, onSocial, onPasskey, passkeyAvailable, error }: {
  onClose: () => void;
  onSocial: (p: "github" | "google") => void;
  onPasskey: () => void;
  passkeyAvailable: boolean;
  error: string | null;
}) {
  return (
    <Modal title="Sign in" onClose={onClose}>
      <div className="ex-signin-choices">
        <button type="button" className="ex-signin-choice" onClick={() => onSocial("github")}>Sign in with GitHub</button>
        <button type="button" className="ex-signin-choice" onClick={() => onSocial("google")}>Sign in with Google</button>
        {passkeyAvailable && (
          <button type="button" className="ex-signin-choice" onClick={onPasskey}>Use a passkey</button>
        )}
      </div>
      {error && <p className="ex-error" role="alert">{error}</p>}
    </Modal>
  );
}

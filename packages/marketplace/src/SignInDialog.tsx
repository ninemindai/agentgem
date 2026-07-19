// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { Modal } from "./Modal";
import { IconGitHub, IconGoogle, IconX, IconPasskey } from "./icons";

/** The sign-in chooser: one entry per provider plus an optional passkey entry. Presentational —
 *  all effects (OAuth redirect, WebAuthn ceremony) live in the parent so this stays testable. */
export function SignInDialog({ onClose, onSocial, onPasskey, passkeyAvailable, error }: {
  onClose: () => void;
  onSocial: (p: "github" | "google" | "twitter") => void;
  onPasskey: () => void;
  passkeyAvailable: boolean;
  error: string | null;
}) {
  return (
    <Modal title="Sign in" onClose={onClose}>
      <h2 className="ex-signin-title">Sign in</h2>
      <p className="ex-signin-sub">Choose how you&apos;d like to continue.</p>
      <div className="ex-signin-choices">
        <button type="button" className="ex-signin-choice" onClick={() => onSocial("github")}>
          <IconGitHub />Sign in with GitHub
        </button>
        <button type="button" className="ex-signin-choice" onClick={() => onSocial("google")}>
          <IconGoogle />Sign in with Google
        </button>
        <button type="button" className="ex-signin-choice" onClick={() => onSocial("twitter")}>
          <IconX />Sign in with X
        </button>
        {passkeyAvailable && (
          <button type="button" className="ex-signin-choice" onClick={onPasskey}>
            <IconPasskey />Use a passkey
          </button>
        )}
      </div>
      {error && <p className="ex-error" role="alert">{error}</p>}
    </Modal>
  );
}

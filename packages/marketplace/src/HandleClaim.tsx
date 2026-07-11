import { useState } from "react";
import { navigate } from "./nav";

/** Claim a public handle. POSTs to /api/handle (credentialed, cross-origin CORS handled by the
 *  route). The handle names the account; it authorizes nothing. On success the caller refetches the
 *  session so the new handle propagates to the chip and the publish scope. Styled to match the
 *  sibling publish form: `.ex-search` input + `.ex-signin` (gradient) button.
 *
 *  A 409 means the handle is unavailable — but the server deliberately collapses "owned by another
 *  account" and "reserved (an org name AgentGem has seen)" into the same status/message (see
 *  handles.ts's claimHandle doc comment: distinguishing them would let a prober enumerate GitHub
 *  orgs). So this can't show "connect the account that owns it" itself with any certainty — instead
 *  it hands off to /account with a nudge, which never claims to know a provider either; it just
 *  points the caller at the Connect buttons already there. */
export function HandleClaim({ base, onClaimed }: { base: string; onClaimed: () => void }) {
  const [handle, setHandle] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(base + "/api/handle", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: handle.trim() }),
      });
      if (r.ok) { onClaimed(); return; }
      if (r.status === 400) setMsg("Handles use letters, numbers, and hyphens only (1–39 characters).");
      else if (r.status === 409) { navigate(`/account?merge=1&handle=${encodeURIComponent(handle.trim())}`); return; }
      else setMsg(`Could not claim handle (${r.status}).`);
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ex-card">
      <h2>Claim your handle</h2>
      <p style={{ color: "var(--muted)", fontSize: "0.88rem", lineHeight: 1.5, margin: "0 0 14px" }}>
        Your handle is your public name — your profile at <code>/@your-handle</code> and the scope you
        publish gems under. Letters, numbers, and hyphens, up to 39 characters.
      </p>
      <form onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <input
          aria-label="handle" type="text" placeholder="your-handle"
          value={handle} onChange={(e) => setHandle(e.target.value)}
          className="ex-search" style={{ margin: 0, flex: 1 }}
          autoCapitalize="off" autoCorrect="off" spellCheck={false}
        />
        <button
          type="submit" className="ex-signin"
          disabled={busy || handle.trim().length === 0}
          style={{ padding: "0 16px", whiteSpace: "nowrap" }}
        >
          {busy ? "Claiming…" : "Claim"}
        </button>
      </form>
      {msg && <p className="ex-error" role="alert" style={{ margin: "12px 0 0" }}>{msg}</p>}
    </div>
  );
}

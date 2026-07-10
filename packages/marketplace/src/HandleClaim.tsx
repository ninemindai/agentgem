import { useState } from "react";

/** Claim a public handle. POSTs to /api/handle (credentialed, cross-origin CORS handled by the
 *  route). The handle names the account; it authorizes nothing. On success the caller refetches the
 *  session so the new handle propagates to the chip and the publish scope. */
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
        body: JSON.stringify({ handle }),
      });
      if (r.ok) { onClaimed(); return; }
      if (r.status === 400) setMsg("Handles use letters, numbers, and hyphens only (1–39 characters).");
      else if (r.status === 409) setMsg("That handle is taken or reserved. Try another.");
      else setMsg(`Could not claim handle (${r.status}).`);
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ex-card" onSubmit={submit}>
      <p>Claim a handle to publish and get a profile page at <code>/@your-handle</code>.</p>
      <input aria-label="handle" placeholder="your-handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
      <button type="submit" disabled={busy || handle.trim().length === 0}>Claim</button>
      {msg && <p className="ex-error" role="alert">{msg}</p>}
    </form>
  );
}

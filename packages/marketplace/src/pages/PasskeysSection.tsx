// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { Modal } from "../Modal";
import { passkeyErrorMessage } from "../passkeyAuth";

type PasskeyRow = { id: string; name?: string | null; createdAt?: string | Date };
type PasskeyClient = {
  passkey: {
    listUserPasskeys(): Promise<{ data: PasskeyRow[] | null; error: unknown }>;
    addPasskey(a: { name: string }): Promise<{ error: unknown }>;
    deletePasskey(a: { id: string }): Promise<{ error: unknown }>;
  };
};

/** Manage passkeys for the signed-in user: list, add (WebAuthn registration against the current
 *  session), delete. The client is injected so this is testable without the browser ceremony. */
export function PasskeysSection({ client, supported }: { client: PasskeyClient; supported: boolean }) {
  const [rows, setRows] = useState<PasskeyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const reload = useCallback(async () => {
    const res = await client.passkey.listUserPasskeys();
    if (res.error) { setError(passkeyErrorMessage(res.error)); return; }
    setRows(res.data ?? []);
  }, [client]);

  useEffect(() => { void reload(); }, [reload]);

  const add = async () => {
    if (!name.trim()) return;
    const res = await client.passkey.addPasskey({ name: name.trim() });
    if (res.error) { setError(passkeyErrorMessage(res.error)); return; }
    setNaming(false);
    await reload();
  };

  const remove = async (id: string) => {
    setError(null);
    const res = await client.passkey.deletePasskey({ id });
    if (res.error) { setError(passkeyErrorMessage(res.error)); return; }
    await reload();
  };

  return (
    <section className="ex-passkeys">
      <h2>Passkeys</h2>
      <p className="ex-muted">Sign in without GitHub or Google using Face ID, Touch ID, or a security key.</p>
      {rows.length === 0 ? (
        <p className="ex-muted">No passkeys yet.</p>
      ) : (
        <ul className="ex-passkey-list">
          {rows.map((r) => (
            <li key={r.id} className="ex-passkey-row">
              <span className="ex-passkey-meta">
                <span className="ex-passkey-name">{r.name || "Unnamed passkey"}</span>
                {r.createdAt && (
                  <time className="ex-passkey-date" dateTime={new Date(r.createdAt).toISOString()}>
                    {new Date(r.createdAt).toLocaleDateString()}
                  </time>
                )}
              </span>
              <button type="button" className="ex-passkey-del" onClick={() => remove(r.id)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
      {supported && (
        <button
          type="button"
          className="ex-passkey-add"
          onClick={() => { setError(null); setName(""); setNaming(true); }}
        >
          Add a passkey
        </button>
      )}
      {error && <p className="ex-error" role="alert">{error}</p>}
      {naming && (
        <Modal title="Add a passkey" onClose={() => setNaming(false)}>
          <form
            className="ex-passkey-name-form"
            onSubmit={(e) => { e.preventDefault(); void add(); }}
          >
            <label htmlFor="ex-passkey-name">Passkey name</label>
            <input
              id="ex-passkey-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. MacBook"
              autoFocus
            />
            <button type="submit" className="ex-passkey-name-submit">Add passkey</button>
          </form>
        </Modal>
      )}
    </section>
  );
}

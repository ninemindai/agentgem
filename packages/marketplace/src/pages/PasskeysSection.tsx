// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";

type PasskeyRow = { id: string; name?: string | null; createdAt?: string | Date };
type PasskeyClient = {
  passkey: {
    listUserPasskeys(): Promise<{ data: PasskeyRow[] | null; error: unknown }>;
    addPasskey(a: { name: string }): Promise<{ error: unknown }>;
    deletePasskey(a: { id: string }): Promise<{ error: unknown }>;
  };
};

function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return "Something went wrong";
}

/** Manage passkeys for the signed-in user: list, add (WebAuthn registration against the current
 *  session), delete. The client is injected so this is testable without the browser ceremony. */
export function PasskeysSection({ client, supported }: { client: PasskeyClient; supported: boolean }) {
  const [rows, setRows] = useState<PasskeyRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await client.passkey.listUserPasskeys();
    if (res.error) { setError(errMessage(res.error)); return; }
    setRows(res.data ?? []);
  }, [client]);

  useEffect(() => { void reload(); }, [reload]);

  const add = async () => {
    setError(null);
    const name = window.prompt("Name this passkey (e.g. \"MacBook\")");
    if (!name) return;
    const res = await client.passkey.addPasskey({ name });
    if (res.error) { setError(errMessage(res.error)); return; }
    await reload();
  };

  const remove = async (id: string) => {
    setError(null);
    const res = await client.passkey.deletePasskey({ id });
    if (res.error) { setError(errMessage(res.error)); return; }
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
              <span>{r.name || "Unnamed passkey"}</span>
              <button type="button" className="ex-passkey-del" onClick={() => remove(r.id)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
      {supported && <button type="button" className="ex-passkey-add" onClick={add}>Add a passkey</button>}
      {error && <p className="ex-error" role="alert">{error}</p>}
    </section>
  );
}

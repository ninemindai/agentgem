// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// One source of truth for "who is signed in" across the console. Mounted once in
// Shell. Fetched on mount and on explicit refresh() — never polled: the bind only
// changes as a result of a user action in this app.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { bindStatusRoute, makeClient } from "../api/routes.js";

export type IdentityStatus = {
  bound: boolean;
  login?: string;
  provider?: string;
  avatarUrl?: string;
  sessionActive?: boolean;
};

type IdentityContextValue = {
  status: IdentityStatus | null; // null until the first fetch settles
  refresh: () => Promise<void>;
  setStatus: (s: IdentityStatus) => void;
};

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function useIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error("useIdentity must be used inside <IdentityProvider>");
  return ctx;
}

export function IdentityProvider({ apiBase, children }: { apiBase: string; children: ReactNode }): ReactElement {
  const [status, setStatus] = useState<IdentityStatus | null>(null);

  // A status fetch that fails (daemon down, offline) must not take the shell with
  // it — an unbound chip is the correct degraded state.
  const refresh = useCallback(async () => {
    try {
      setStatus(await bindStatusRoute.call(makeClient(apiBase)));
    } catch {
      setStatus({ bound: false });
    }
  }, [apiBase]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Memoized: without this, every render of IdentityProvider (e.g. Shell re-rendering
  // for unrelated reasons) creates a new object identity, forcing every useIdentity()
  // consumer to re-render even when status/refresh haven't changed. setStatus is
  // React's stable setter and doesn't need to be a dependency.
  const value = useMemo(() => ({ status, refresh, setStatus }), [status, refresh]);

  return (
    <IdentityContext.Provider value={value}>
      {children}
    </IdentityContext.Provider>
  );
}

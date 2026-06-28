// One-shot hand-off of an analyze recommendation from the Testbed panel to the
// Ledger: Testbed stashes the recommended selection keys, navigates to #/ledger,
// and the Ledger consumes them once on mount.
let pending: string[] | null = null;

export function setRecommendedSelection(keys: string[]): void {
  pending = keys;
}

/** Read and clear the pending recommendation (null if none). */
export function takeRecommendedSelection(): string[] | null {
  const out = pending;
  pending = null;
  return out;
}

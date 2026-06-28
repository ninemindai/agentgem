import { useSyncExternalStore } from "react";

// The gem-in-progress: which inventory items are selected (group::name keys) and
// the gem's name. Shared by Curate/Materialize/Deploy so the active Gem carries
// across stages. A single module-level store with subscription.
let keys: Set<string> = new Set();
let name = "";
const listeners = new Set<() => void>();

function emit() { for (const l of listeners) l(); }

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getKeys(): Set<string> { return keys; }
export function getName(): string { return name; }

export function setKeys(next: Set<string>): void { keys = new Set(next); emit(); }
export function toggleKey(key: string): void {
  const next = new Set(keys);
  if (next.has(key)) next.delete(key); else next.add(key);
  keys = next; emit();
}
export function clearKeys(): void { keys = new Set(); emit(); }
export function setName(next: string): void { name = next; emit(); }
export function resetGem(): void { keys = new Set(); name = ""; emit(); }

/** React hook: re-renders the caller whenever the active gem changes. */
export function useActiveGem(): { keys: Set<string>; name: string } {
  const snap = useSyncExternalStore(subscribe, () => stableSnapshot());
  return snap;
}

// useSyncExternalStore requires a stable snapshot reference between renders when
// nothing changed; rebuild only on emit by caching the last (keys,name) tuple.
let snapshot = { keys, name };
function stableSnapshot() {
  if (snapshot.keys !== keys || snapshot.name !== name) snapshot = { keys, name };
  return snapshot;
}

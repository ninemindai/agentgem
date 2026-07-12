// App-side offline pin store. "Download for offline" writes a game's html into a dedicated Cache
// Storage bucket the service worker checks first (and never evicts), plus a small localStorage index
// so the /offline library can list pins without walking Cache Storage. The URL a pin is stored under
// is gameHtmlUrl(...), identical to what api.getGameHtml fetches — that identity is what lets the SW
// serve a pinned game offline.
import { gameHtmlUrl } from "./api";

export const PINNED_CACHE = "games-pinned";
const INDEX_KEY = "games-pinned-index";

export interface PinnedGame {
  key: string;
  version: string;
  title: string;
  size: number;      // bytes of the html payload, for the storage readout
  pinnedAt: number;  // epoch ms
}

function readIndex(): PinnedGame[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? (JSON.parse(raw) as PinnedGame[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(list: PinnedGame[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(list));
}

export function listPinned(): PinnedGame[] {
  return readIndex();
}

export function isPinned(key: string, version: string): boolean {
  return readIndex().some((p) => p.key === key && p.version === version);
}

export async function pinGame(base: string, key: string, version: string, title: string): Promise<void> {
  const url = gameHtmlUrl(base, key, version);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pin ${key} -> ${res.status}`);
  const body = await res.clone().text();
  const cache = await caches.open(PINNED_CACHE);
  await cache.put(url, res);
  const size = new Blob([body]).size;
  const list = readIndex().filter((p) => !(p.key === key && p.version === version));
  list.push({ key, version, title, size, pinnedAt: Date.now() });
  writeIndex(list);
}

export async function unpinGame(base: string, key: string, version: string): Promise<void> {
  const cache = await caches.open(PINNED_CACHE);
  await cache.delete(gameHtmlUrl(base, key, version));
  writeIndex(readIndex().filter((p) => !(p.key === key && p.version === version)));
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

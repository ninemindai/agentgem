// Pure, testable pieces of the service worker's game-html caching. Kept out of sw.ts (which imports
// workbox and touches `self`) so they can be unit-tested in jsdom. The cache names are the contract
// with offline.ts; swCache.test asserts PINNED_CACHE matches the app-side value.
export const PINNED_CACHE = "games-pinned";
export const RECENT_CACHE = "games-recent";
export const MAX_RECENT = 20;

const GAME_HTML_PATH = "/api/aggregator/game-html";

/** True for a GET of the game-html endpoint, on whatever origin the API is served from. */
export function isGameHtmlRequest(url: URL): boolean {
  return url.pathname === GAME_HTML_PATH;
}

/** Given cache keys in insertion (oldest-first) order, the entries to delete to honour `limit`. */
export function overLimit(keys: readonly Request[], limit: number): Request[] {
  return keys.slice(0, Math.max(0, keys.length - limit));
}

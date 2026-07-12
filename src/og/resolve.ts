// Resolve an SPA pathname to the entity a shareable link addresses. Route shapes mirror
// packages/marketplace/src/Router.tsx (the source of truth) — keep the two in sync.
export type CardType = "game" | "gem" | "profile" | "skill";
export interface Card { type: CardType; key: string }

function dec(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function resolveCard(pathname: string): Card | null {
  let m: RegExpMatchArray | null;
  if ((m = pathname.match(/^\/games\/(.+)$/))) return { type: "game", key: dec(m[1]) };
  if ((m = pathname.match(/^\/gems\/(.+)$/))) return { type: "gem", key: dec(m[1]) };
  if ((m = pathname.match(/^\/@([^/]+)$/))) return { type: "profile", key: dec(m[1]) };
  if ((m = pathname.match(/^\/skills\/([^/]+)\/(.+)$/))) return { type: "skill", key: `${dec(m[1])}/${dec(m[2])}` };
  return null;
}

// Cross-panel deep-link intent. The console's hash router matches routes by exact
// equality (Shell.tsx: `p.route === hash`), so query suffixes like `#/get-gems?q=x`
// would not resolve. Instead we hand the pending search to Get Gems through this
// module-level holder and navigate to the clean `#/get-gems`. One-shot: taking it clears it.
let pending: string | null = null;

export function setPendingQuery(q: string): void { pending = q; }

export function takePendingQuery(): string | null {
  const v = pending;
  pending = null;
  return v;
}

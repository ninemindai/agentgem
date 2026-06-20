export const REGISTRY_FORMAT_VERSION = 1;

export interface RegistryItemVersion { path: string; gemDigest: string; dependencies: string[] }
export interface RegistryItem { latest: string; versions: Record<string, RegistryItemVersion> }
export interface RegistryIndex { formatVersion: number; items: Record<string, RegistryItem> }

export interface ParsedRef { key: string; scope: string; name: string; range: string }

const SEG = /^[a-z0-9-]+$/;

export function parseRef(input: string): ParsedRef {
  const at = input.indexOf("@", 1); // a version "@" can only appear after the leading "@scope/name"
  const body = at > 0 ? input.slice(0, at) : input;
  const range = at > 0 ? input.slice(at + 1) : "latest";
  if (!body.startsWith("@")) throw new Error(`invalid ref '${input}': must start with a scope, e.g. @scope/name`);
  const slash = body.indexOf("/");
  if (slash < 0) throw new Error(`invalid ref '${input}': missing scope separator '/'`);
  const scope = body.slice(1, slash);
  const name = body.slice(slash + 1);
  if (!SEG.test(scope) || !SEG.test(name)) throw new Error(`invalid ref '${input}': scope/name must match [a-z0-9-]`);
  if (range !== "latest" && !/^\^?\d+\.\d+\.\d+$/.test(range)) throw new Error(`invalid ref '${input}': bad version range '${range}'`);
  return { key: `@${scope}/${name}`, scope, name, range };
}

// ── minimal semver (exact + caret only; no external dep) ──
function parseSemver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`invalid semver '${v}'`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function cmpSemver(a: string, b: string): number {
  const x = parseSemver(a), y = parseSemver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
function satisfies(version: string, range: string): boolean {
  if (!range.startsWith("^")) return cmpSemver(version, range) === 0;
  const base = range.slice(1);
  const [bMaj, bMin] = parseSemver(base);
  const [vMaj, vMin] = parseSemver(version);
  if (cmpSemver(version, base) < 0) return false;       // must be >= base
  if (bMaj > 0) return vMaj === bMaj;                    // ^1.2.3 := >=1.2.3 <2.0.0
  if (bMin > 0) return vMaj === 0 && vMin === bMin;      // ^0.2.3 := >=0.2.3 <0.3.0
  return cmpSemver(version, base) === 0;                 // ^0.0.3 := exact
}

export function selectVersion(item: RegistryItem, range: string): string {
  if (range === "latest") {
    if (item.versions[item.latest] === undefined)
      throw new Error(`latest version '${item.latest}' is not present in the item's versions`);
    return item.latest;
  }
  const matches = Object.keys(item.versions).filter((v) => satisfies(v, range));
  if (matches.length === 0) throw new Error(`no version of item satisfies '${range}'`);
  return matches.sort(cmpSemver)[matches.length - 1];
}

export interface ResolvedNode { key: string; version: string; path: string; gemDigest: string; deps: string[] }

export function resolveGraph(rootRefs: string[], index: RegistryIndex): ResolvedNode[] {
  const chosen = new Map<string, { version: string; by: string }>(); // key -> selection

  const choose = (ref: string, requestedBy: string): { key: string; version: string } => {
    const { key, range } = parseRef(ref);
    const item = index.items[key];
    if (!item) throw new Error(`unknown item '${key}' (requested by ${requestedBy})`);
    const version = selectVersion(item, range);
    const prev = chosen.get(key);
    if (prev && prev.version !== version) {
      throw new Error(`version conflict for ${key}: ${prev.by} wants ${prev.version}, ${requestedBy} wants ${version}`);
    }
    if (!prev) chosen.set(key, { version, by: requestedBy });
    return { key, version };
  };

  const order: ResolvedNode[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (key: string, version: string, trail: string[]): void => {
    const s = state.get(key);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`dependency cycle: ${[...trail, key].join(" -> ")}`);
    state.set(key, "visiting");
    const v = index.items[key].versions[version];
    if (v === undefined) throw new Error(`resolved version ${key}@${version} not found in the index`);
    const depKeys: string[] = [];
    for (const depRef of v.dependencies) {
      const { key: dKey, version: dVer } = choose(depRef, `${key}@${version}`);
      depKeys.push(dKey);
      visit(dKey, dVer, [...trail, key]);
    }
    order.push({ key, version, path: v.path, gemDigest: v.gemDigest, deps: depKeys });
    state.set(key, "done");
  };

  for (const ref of rootRefs) {
    const { key, version } = choose(ref, "(root)");
    visit(key, version, []);
  }
  return order;
}

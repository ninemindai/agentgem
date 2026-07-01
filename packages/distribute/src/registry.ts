// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import type { Gem, GemArtifact, SecretRequirement, GemCheck } from "@agentgem/model";
import { readGemArchive, computeLock, verifyLock, writeGemArchive, readGemMeta } from "@agentgem/archive";
import { materialize } from "@agentgem/model";
import type { FileTree, TargetId } from "@agentgem/model";

export const REGISTRY_FORMAT_VERSION = 1;

export interface RegistryItemVersion { path: string; gemDigest: string; dependencies: string[] }
// Denormalized, searchable metadata for the latest version — additive/optional so older
// readers ignore it and the format version need not bump. Populated at publish time.
export interface RegistryItemDiscovery {
  description?: string;
  tags?: string[];
  author?: string;
  artifactKinds?: string[];
  updatedAt?: string;
  type?: string;        // the gem's cut (setup/kit/skill/integration/guide/playbook + plugin cuts)
  publishedBy?: string; // server-verified GitHub login of the publishing account (distinct from free-form `author`)
  grade?: number;       // authoring-quality floor (1..3) forwarded from the gem; the marketplace blends it with stars
}
export interface RegistryItem { latest: string; versions: Record<string, RegistryItemVersion>; discovery?: RegistryItemDiscovery }
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

export interface RegistrySource {
  id: string; label: string;
  ready(): boolean;
  getIndex(): Promise<RegistryIndex>;
  fetchItem(path: string): Promise<FileTree>;
}
export interface Provenance {
  items: { key: string; version: string }[];
  overrides: { artifact: string; winner: string; loser: string }[];
}

const artifactContentKey = (a: GemArtifact): string => JSON.stringify(a);

export async function mergeGems(graph: ResolvedNode[], source: RegistrySource): Promise<{ gem: Gem; provenance: Provenance }> {
  // ancestor sets: which keys is `key` (transitively) built on? deps appear before dependents in `graph`.
  const directDeps = new Map(graph.map((n) => [n.key, n.deps]));
  const ancestorsOf = (key: string): Set<string> => {
    const out = new Set<string>(); const stack = [...(directDeps.get(key) ?? [])];
    while (stack.length) { const k = stack.pop()!; if (!out.has(k)) { out.add(k); stack.push(...(directDeps.get(k) ?? [])); } }
    return out;
  };

  const byName = new Map<string, { artifact: GemArtifact; owner: string; contentKey: string }>();
  const secrets = new Map<string, SecretRequirement>();
  const byCheckName = new Map<string, { check: GemCheck; owner: string; contentKey: string }>();
  const provenance: Provenance = { items: [], overrides: [] };

  for (const node of graph) {
    const files = await source.fetchItem(node.path);
    if (files["gem.lock"] === undefined) throw new Error(`archive for ${node.key}@${node.version} is missing gem.lock`);
    const v = verifyLock(files, JSON.parse(files["gem.lock"]));
    if (!v.ok) throw new Error(`integrity failure for ${node.key}@${node.version}: lock mismatch [${v.mismatches.join(",")}]`);
    if (computeLock(files).gemDigest !== node.gemDigest) {
      throw new Error(`integrity failure for ${node.key}@${node.version}: digest disagrees with the registry index`);
    }
    const gem = readGemArchive(files);
    provenance.items.push({ key: node.key, version: node.version });

    for (const artifact of gem.artifacts) {
      const contentKey = artifactContentKey(artifact);
      const prev = byName.get(artifact.name);
      if (!prev) { byName.set(artifact.name, { artifact, owner: node.key, contentKey }); continue; }
      if (prev.contentKey === contentKey) continue;                       // identical via two paths → dedup
      if (ancestorsOf(node.key).has(prev.owner)) {                        // dependent overrides ancestor
        byName.set(artifact.name, { artifact, owner: node.key, contentKey });
        provenance.overrides.push({ artifact: artifact.name, winner: node.key, loser: prev.owner });
        continue;
      }
      throw new Error(`artifact name collision: '${artifact.name}' defined by unrelated items ${prev.owner} and ${node.key}`);
    }
    for (const s of gem.requiredSecrets) secrets.set(`${s.name}:${s.location}`, s);
    for (const c of gem.checks) {
      const contentKey = JSON.stringify(c);
      const prev = byCheckName.get(c.name);
      if (!prev) { byCheckName.set(c.name, { check: c, owner: node.key, contentKey }); continue; }
      if (prev.contentKey === contentKey) continue;                       // identical via two paths → dedup
      if (ancestorsOf(node.key).has(prev.owner)) {                        // dependent overrides ancestor
        byCheckName.set(c.name, { check: c, owner: node.key, contentKey });
        continue;
      }
      throw new Error(`check name collision: '${c.name}' defined by unrelated items ${prev.owner} and ${node.key}`);
    }
  }

  const rootKey = graph.length ? graph[graph.length - 1].key : "(empty)";
  const rootVer = graph.length ? graph[graph.length - 1].version : "0.0.0";
  const merged: Gem = {
    name: rootKey.split("/").pop() ?? "gem",
    createdFrom: `registry:${rootKey}@${rootVer}`,
    artifacts: [...byName.values()].map((e) => e.artifact),
    checks: [...byCheckName.values()].map((e) => e.check),
    requiredSecrets: [...secrets.values()],
  };
  return { gem: merged, provenance };
}

// ── publish ────────────────────────────────────────────────────────────────

export interface RegistryPublisher {
  putCommit(files: FileTree, message: string): Promise<{ commit: string }>;
}

// Derive the searchable discovery block for a publish: caller-supplied description/tags,
// falling back to the first artifact's description; kinds/author derived from the gem.
export function buildDiscovery(
  gem: Gem, scope: string, opts: { description?: string; tags?: string[]; updatedAt?: string; type?: string; publishedBy?: string; grade?: number } = {},
): RegistryItemDiscovery {
  const description = opts.description ?? gem.artifacts.find((a) => "description" in a && a.description)?.["description" as never];
  const tags = (opts.tags ?? []).map((t) => t.toLowerCase());
  const artifactKinds = [...new Set(gem.artifacts.map((a) => a.type))];
  const d: RegistryItemDiscovery = { author: scope, artifactKinds };
  if (description) d.description = description;
  if (tags.length) d.tags = tags;
  if (opts.updatedAt) d.updatedAt = opts.updatedAt;
  if (opts.type) d.type = opts.type;
  if (opts.publishedBy) d.publishedBy = opts.publishedBy;
  if (opts.grade != null) d.grade = opts.grade;
  return d;
}

export function updateIndex(
  index: RegistryIndex,
  e: { key: string; version: string; path: string; gemDigest: string; dependencies: string[]; discovery?: RegistryItemDiscovery },
): RegistryIndex {
  const items = { ...index.items };
  const existing = items[e.key];
  const versions = { ...(existing?.versions ?? {}) };
  const existingVersion = existing?.versions[e.version];
  if (existingVersion && existingVersion.gemDigest !== e.gemDigest) {
    throw new Error(`${e.key}@${e.version} is immutable (published ${existingVersion.gemDigest}, attempted ${e.gemDigest})`);
  }
  versions[e.version] = { path: e.path, gemDigest: e.gemDigest, dependencies: e.dependencies };
  const isNewLatest = !existing || cmpSemver(existing.latest, e.version) < 0;
  const latest = isNewLatest ? e.version : existing.latest;
  // discovery reflects the latest version; keep the prior block when publishing an older version
  const discovery = isNewLatest ? (e.discovery ?? existing?.discovery) : existing?.discovery;
  items[e.key] = { latest, versions, ...(discovery ? { discovery } : {}) };
  return { formatVersion: REGISTRY_FORMAT_VERSION, items };
}

export async function publishGem(args: {
  gem: Gem; scope: string; name?: string; version: string; dependencies?: string[];
  index: RegistryIndex; publisher: RegistryPublisher;
  description?: string; tags?: string[]; updatedAt?: string; type?: string; publishedBy?: string; grade?: number;
}): Promise<{ ref: string; version: string; gemDigest: string; commit: string; path: string }> {
  const name = args.name ?? args.gem.name;
  if (!SEG.test(args.scope) || !SEG.test(name)) throw new Error(`invalid scope/name '@${args.scope}/${name}': must match [a-z0-9-]`);
  parseSemver(args.version); // validate
  const key = `@${args.scope}/${name}`;
  const path = `items/${args.scope}/${name}/${args.version}`;

  const { files } = writeGemArchive(args.gem, { version: args.version, dependencies: args.dependencies });
  const { gemDigest, dependencies } = readGemMeta(files);

  const prior = args.index.items[key]?.versions[args.version];
  if (prior && prior.gemDigest !== gemDigest) {
    throw new Error(`${key}@${args.version} is already published and immutable (published ${prior.gemDigest}, attempted ${gemDigest})`);
  }
  if (prior && prior.gemDigest === gemDigest) {
    return { ref: key, version: args.version, gemDigest, commit: "", path };
  }

  const discovery = buildDiscovery(args.gem, args.scope, { description: args.description, tags: args.tags, updatedAt: args.updatedAt, type: args.type, publishedBy: args.publishedBy, grade: args.grade });
  const nextIndex = updateIndex(args.index, { key, version: args.version, path, gemDigest, dependencies, discovery });
  const commitFiles: FileTree = { "registry.json": JSON.stringify(nextIndex, null, 2) };
  for (const [rel, content] of Object.entries(files)) commitFiles[`${path}/${rel}`] = content;

  const { commit } = await args.publisher.putCommit(commitFiles, `publish ${key}@${args.version}`);
  return { ref: key, version: args.version, gemDigest, commit, path };
}

// ── install ────────────────────────────────────────────────────────────────

export interface InstallPlan {
  items: { key: string; version: string }[];
  totalArtifacts: number;
  requiredSecrets: SecretRequirement[];
  overrides: Provenance["overrides"];
  materialize?: { files: FileTree; skipped: { artifact: string; type: string; reason: string }[] };
}

export async function resolveInstall(args: {
  refs: string[]; mode: "materialize" | "workspace"; target?: TargetId; source: RegistrySource; a2aServer?: boolean;
}): Promise<{ plan: InstallPlan; gem: Gem }> {
  const index = await args.source.getIndex();
  const graph = resolveGraph(args.refs, index);
  const { gem, provenance } = await mergeGems(graph, args.source);

  const plan: InstallPlan = {
    items: provenance.items,
    totalArtifacts: gem.artifacts.length,
    requiredSecrets: gem.requiredSecrets,
    overrides: provenance.overrides,
  };
  if (args.mode === "materialize") {
    if (!args.target) throw new Error("materialize mode requires a target harness id");
    plan.materialize = materialize(gem, args.target, { a2aServer: args.a2aServer });
  }
  return { plan, gem };
}

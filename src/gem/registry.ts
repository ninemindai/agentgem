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

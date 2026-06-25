// src/gem/safeFetch.ts
// SSRF guard for installing a .gem from a URL. A localhost-bound dev server is still
// reachable by a malicious page via CSRF, so an unguarded server-side fetch lets an
// attacker reach cloud metadata (169.254.169.254) or internal hosts. We resolve the
// host and refuse any non-public address, re-validate every redirect hop, AND pin the
// socket to the validated IP via an undici dispatcher so a DNS rebind between the
// validation and the connect cannot swing the request onto a blocked address.
import { lookup } from "node:dns/promises";
import { Agent } from "undici";

interface LookupAddress { address: string; family: number }

// True for loopback, RFC1918, CGNAT, link-local/metadata, and IPv6 loopback/link-local/ULA.
export function isBlockedAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 0 || a === 127) return true;                 // 0.0.0.0/8, loopback
    if (a === 10) return true;                             // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;      // RFC1918
    if (a === 192 && b === 168) return true;               // RFC1918
    if (a === 169 && b === 254) return true;               // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT 100.64/10
    return false;
  }
  const v6 = ip.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (v6 === "::1" || v6 === "::") return true;            // loopback / unspecified
  if (v6.startsWith("fe80")) return true;                  // link-local
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique-local fc00::/7
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isBlockedAddress(mapped[1]);
  return false;
}

export interface SafeFetchOpts { allowPrivate?: boolean; maxRedirects?: number; maxBytes?: number }

// Parse + scheme-check + DNS-resolve a URL, rejecting any non-public address.
// Returns the URL plus the validated addresses (null when allowPrivate skips resolution).
async function validatePublic(raw: string, opts: SafeFetchOpts): Promise<{ url: URL; validated: LookupAddress[] | null }> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`invalid gem URL: ${raw}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`gem URL must be http(s), got ${u.protocol}`);
  }
  if (opts.allowPrivate) return { url: u, validated: null };
  const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "");
  const results = await lookup(host, { all: true });
  if (results.length === 0) throw new Error(`could not resolve gem URL host: ${host}`);
  for (const r of results) {
    if (isBlockedAddress(r.address)) throw new Error(`refusing to fetch gem from non-public address ${r.address} (${host})`);
  }
  return { url: u, validated: results };
}

export async function assertPublicUrl(raw: string, opts: SafeFetchOpts = {}): Promise<URL> {
  return (await validatePublic(raw, opts)).url;
}

// A Node lookup function pinned to the validated addresses — it ignores the hostname it is
// asked to resolve, so a host that rebinds to a blocked IP after validation cannot redirect
// the socket. This is the piece that actually closes the validate→connect race.
export function makePinnedLookup(validated: LookupAddress[]) {
  return (_hostname: string, options: { all?: boolean } | ((e: unknown, a?: unknown, f?: unknown) => void), callback?: (e: unknown, a?: unknown, f?: unknown) => void) => {
    const cb = (typeof options === "function" ? options : callback)!;
    const all = typeof options === "object" && options.all;
    if (all) cb(null, validated);
    else cb(null, validated[0].address, validated[0].family);
  };
}

// Fetch a .gem over http(s): validate the URL + every redirect hop, and pin each connection
// to the validated IP set via an undici dispatcher. Size-capped.
export async function fetchGemBytes(raw: string, opts: SafeFetchOpts = {}): Promise<Buffer> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  let target = raw;
  for (let hop = 0; ; hop++) {
    const { url, validated } = await validatePublic(target, opts);
    const dispatcher = validated ? new Agent({ connect: { lookup: makePinnedLookup(validated) as never } }) : undefined;
    try {
      const res = await fetch(url.toString(), { redirect: "manual", ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        if (hop >= maxRedirects) throw new Error("too many redirects fetching gem");
        target = new URL(loc, url).toString();
        continue;
      }
      if (!res.ok) throw new Error(`gem fetch failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`gem exceeds max size (${buf.length} > ${maxBytes} bytes)`);
      return buf;
    } finally {
      await dispatcher?.close();
    }
  }
}

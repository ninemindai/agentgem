// Parse/build image data URLs for miniapp cover screenshots. Used on the store side (publishGem parses
// the client's coverDataUrl) and the render side (getCoverDataUri rebuilds one from stored bytes).
export const COVER_MAX_BYTES = 512 * 1024;
export const COVER_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

// A base64 string of length N decodes to at most ~N*3/4 bytes. Reject anything that couldn't possibly
// fit under the cap BEFORE decoding, so an attacker-controlled oversized payload isn't materialized
// into a Buffer just to be rejected. (HTTP body limits bound this upstream too — defense in depth.)
const MAX_B64_LEN = Math.ceil(COVER_MAX_BYTES / 3) * 4 + 4;

export function parseImageDataUrl(s: string): { contentType: string; bytes: Uint8Array } | null {
  const m = typeof s === "string" ? s.match(RE) : null;
  if (!m) return null;
  const contentType = m[1];
  if (!(COVER_TYPES as readonly string[]).includes(contentType)) return null;
  if (m[2].length > MAX_B64_LEN) return null; // pre-decode guard — reject before allocating
  // The RE already restricts m[2] to the base64 charset and Node's base64 decoder never throws,
  // so no try/catch is needed here.
  const bytes = new Uint8Array(Buffer.from(m[2], "base64"));
  if (bytes.length === 0 || bytes.length > COVER_MAX_BYTES) return null;
  return { contentType, bytes };
}

export function toDataUrl(contentType: string, bytes: Uint8Array): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

// Parse/build image data URLs for miniapp cover screenshots. Used on the store side (publishGem parses
// the client's coverDataUrl) and the render side (getCoverDataUri rebuilds one from stored bytes).
export const COVER_MAX_BYTES = 512 * 1024;
export const COVER_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

export function parseImageDataUrl(s: string): { contentType: string; bytes: Uint8Array } | null {
  const m = typeof s === "string" ? s.match(RE) : null;
  if (!m) return null;
  const contentType = m[1];
  if (!(COVER_TYPES as readonly string[]).includes(contentType)) return null;
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(Buffer.from(m[2], "base64")); } catch { return null; }
  if (bytes.length === 0 || bytes.length > COVER_MAX_BYTES) return null;
  return { contentType, bytes };
}

export function toDataUrl(contentType: string, bytes: Uint8Array): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export interface Ticket { bucket: string; object: string; key: Buffer }

const SCHEME = "agentgem:";

// agentgem://gem/<bucket>/<object>#<base64url-key>  (key lives ONLY in the fragment)
export function encodeTicket(t: Ticket): string {
  const b = encodeURIComponent(t.bucket);
  const o = encodeURIComponent(t.object);
  return `agentgem://gem/${b}/${o}#${t.key.toString("base64url")}`;
}

export function parseTicket(s: string): Ticket {
  const url = new URL(s);
  if (url.protocol !== SCHEME || url.host !== "gem") {
    throw new Error("ticket: not an agentgem gem ticket");
  }
  const parts = url.pathname.replace(/^\//, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("ticket: malformed path");
  const key = Buffer.from(url.hash.replace(/^#/, ""), "base64url");
  if (key.length !== 32) throw new Error("ticket: key must be 32 bytes");
  return { bucket: decodeURIComponent(parts[0]), object: decodeURIComponent(parts[1]), key };
}

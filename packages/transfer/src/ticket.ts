// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
export interface Ticket {
  bucket: string;
  object: string;
  key: Buffer;
  producer?: { publicKey: string; signature: string; account?: string };
}

const SCHEME = "agentgem:";

// agentgem://gem/<bucket>/<object>#<keyB64url>[~<producerB64url>]
// The key (and producer) live ONLY in the fragment, never sent to the server.
export function encodeTicket(t: Ticket): string {
  const b = encodeURIComponent(t.bucket);
  const o = encodeURIComponent(t.object);
  let frag = t.key.toString("base64url");
  if (t.producer) frag += "~" + Buffer.from(JSON.stringify(t.producer)).toString("base64url");
  return `agentgem://gem/${b}/${o}#${frag}`;
}

export function parseTicket(s: string): Ticket {
  const url = new URL(s);
  if (url.protocol !== SCHEME || url.host !== "gem") {
    throw new Error("ticket: not an agentgem gem ticket");
  }
  const parts = url.pathname.replace(/^\//, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("ticket: malformed path");
  const [keyB64url, producerB64url] = url.hash.replace(/^#/, "").split("~");
  const key = Buffer.from(keyB64url, "base64url");
  if (key.length !== 32) throw new Error("ticket: key must be 32 bytes");
  const ticket: Ticket = { bucket: decodeURIComponent(parts[0]), object: decodeURIComponent(parts[1]), key };
  if (producerB64url) {
    try {
      const p = JSON.parse(Buffer.from(producerB64url, "base64url").toString("utf8"));
      if (p && typeof p.publicKey === "string" && typeof p.signature === "string") {
        ticket.producer = { publicKey: p.publicKey, signature: p.signature, ...(typeof p.account === "string" ? { account: p.account } : {}) };
      }
    } catch { /* malformed producer → unsigned */ }
  }
  return ticket;
}

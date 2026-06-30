import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { shareCards } from "../aggregator/schema.js";
import type { AppDb } from "../aggregator/schema.js";

export type ShareCounts = { breadth: number; battleTested: number; portable: number };
export type GemPayload = { name: string; provenance: string };

export type CreateInput =
  | { kind: "certificate"; counts: ShareCounts; generatedAtMs: number }
  | { kind: "gem"; name: string; provenance: string; generatedAtMs: number };

export type ShareRecord =
  | { kind: "certificate"; counts: ShareCounts; generatedAtMs: number; createdAtMs: number }
  | { kind: "gem"; name: string; provenance: string; generatedAtMs: number; createdAtMs: number };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function genShareId(len = 10): string {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

export const SHARE_BASE = process.env.SHARE_BASE ?? "https://agentgem.ai";

export async function createShareCard(db: AppDb, input: CreateInput): Promise<{ id: string; url: string }> {
  const id = genShareId();
  const row = {
    id, kind: input.kind, generatedAtMs: input.generatedAtMs, createdAtMs: Date.now(),
    counts: input.kind === "certificate" ? input.counts : null,
    payload: input.kind === "gem" ? { name: input.name, provenance: input.provenance } : null,
  };
  await db.insert(shareCards).values(row);
  return { id, url: `${SHARE_BASE}/share/${id}` };
}

export async function getShareCard(db: AppDb, id: string): Promise<ShareRecord | null> {
  const rows = await db.select().from(shareCards).where(sql`id = ${id}`);
  if (rows.length === 0) return null;
  const r = rows[0];
  const base = { generatedAtMs: Number(r.generatedAtMs), createdAtMs: Number(r.createdAtMs) };
  if (r.kind === "gem") {
    const p = r.payload as GemPayload;
    return { kind: "gem", name: p.name, provenance: p.provenance, ...base };
  }
  return { kind: "certificate", counts: r.counts as ShareCounts, ...base };
}

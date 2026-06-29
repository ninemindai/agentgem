import { randomBytes, randomUUID, createHash } from "node:crypto";
import { eq, and, isNull, desc } from "drizzle-orm";
import { apiKeys, type AppDb } from "./schema.js";

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A fresh key: `ag_` + 32 random bytes (base64url), and its sha256 hash. */
export function generateKey(): { plaintext: string; hash: string } {
  const plaintext = "ag_" + randomBytes(32).toString("base64url");
  return { plaintext, hash: sha256hex(plaintext) };
}

/** Mint + persist a key (hash only). Returns the plaintext ONCE. */
export async function issueKey(db: AppDb, label: string): Promise<{ id: string; plaintext: string; label: string }> {
  const { plaintext, hash } = generateKey();
  const id = randomUUID();
  await db.insert(apiKeys).values({ id, keyHash: hash, label });
  return { id, plaintext, label };
}

/** Resolve a plaintext key to its (active) record, or null if unknown/revoked. */
export async function verifyKey(db: AppDb, plaintext: string): Promise<{ id: string; label: string } | null> {
  const rows = await db
    .select({ id: apiKeys.id, label: apiKeys.label })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, sha256hex(plaintext)), isNull(apiKeys.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** Revoke a key by id. Returns false if it was already revoked or not found. */
export async function revokeKey(db: AppDb, id: string): Promise<boolean> {
  const res = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return res.length > 0;
}

/** All keys, newest first — metadata only, never the hash. */
export async function listKeys(db: AppDb): Promise<{ id: string; label: string; createdAt: Date; revokedAt: Date | null }[]> {
  return db
    .select({ id: apiKeys.id, label: apiKeys.label, createdAt: apiKeys.createdAt, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt));
}

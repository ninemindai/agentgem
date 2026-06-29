import { pgTable, text, integer, uuid, timestamp, boolean, real, primaryKey, jsonb, bigint } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

export const producers = pgTable("producers", {
  pubkey: text("pubkey").primaryKey(),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  attestCount: integer("attest_count").notNull().default(0),
});
export const attestations = pgTable("attestations", {
  id: uuid("id").primaryKey(),
  gemName: text("gem_name").notNull(),
  gemDigest: text("gem_digest").notNull().unique(),
  producerPubkey: text("producer_pubkey").notNull().references(() => producers.pubkey),
  harnessId: text("harness_id").notNull(),
  models: text("models").array().notNull().default(sql`'{}'::text[]`),
  scanSessions: integer("scan_sessions").notNull(),
  scanSpanDays: integer("scan_span_days").notNull(),
  signalDigest: text("signal_digest").notNull(),
  privateCount: integer("private_count").notNull().default(0),
  trustScore: real("trust_score").notNull().default(1),
  quarantined: boolean("quarantined").notNull().default(false),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
});
export const ingredients = pgTable("ingredients", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  idKind: text("id_kind").notNull(),
  displayName: text("display_name"),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
});
export const usageEdges = pgTable("usage_edges", {
  attestationId: uuid("attestation_id").notNull().references(() => attestations.id),
  ingredientId: text("ingredient_id").notNull().references(() => ingredients.id),
  invocations: integer("invocations").notNull(),
  sessions: integer("sessions").notNull(),
}, (t) => [primaryKey({ columns: [t.attestationId, t.ingredientId] })]);

export const accountBindings = pgTable("account_bindings", {
  pubkey: text("pubkey").primaryKey().references(() => producers.pubkey),
  provider: text("provider").notNull(),
  accountId: text("account_id").notNull(),
  accountLogin: text("account_login").notNull(),
  boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shareCards = pgTable("share_cards", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  counts: jsonb("counts").notNull().$type<{ breadth: number; battleTested: number; portable: number }>(),
  generatedAtMs: bigint("generated_at_ms", { mode: "number" }).notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
});

export const schema = { producers, attestations, ingredients, usageEdges, accountBindings, shareCards };
export type AppDb = PgDatabase<any, typeof schema>;

// Idempotent DDL. (Schema-as-tables above is the query source of truth; this DDL
// creates them. A column drift is caught immediately by the typed drizzle inserts.
// drizzle-kit migrations are a deferred follow-up when the schema starts evolving.)
export async function ensureSchema(db: AppDb): Promise<void> {
  await db.execute(sql`create table if not exists producers (pubkey text primary key, first_seen timestamptz not null default now(), attest_count int not null default 0)`);
  await db.execute(sql`create table if not exists attestations (id uuid primary key, gem_name text not null, gem_digest text not null unique, producer_pubkey text not null references producers(pubkey), harness_id text not null, models text[] not null default '{}', scan_sessions int not null, scan_span_days int not null, signal_digest text not null, private_count int not null default 0, trust_score real not null default 1, quarantined boolean not null default false, ingested_at timestamptz not null default now())`);
  await db.execute(sql`create table if not exists ingredients (id text primary key, kind text not null, id_kind text not null, display_name text, first_seen timestamptz not null default now(), last_seen timestamptz not null default now())`);
  await db.execute(sql`create table if not exists usage_edges (attestation_id uuid not null references attestations(id), ingredient_id text not null references ingredients(id), invocations int not null, sessions int not null, primary key (attestation_id, ingredient_id))`);
  await db.execute(sql`create table if not exists account_bindings (pubkey text primary key references producers(pubkey), provider text not null, account_id text not null, account_login text not null, bound_at timestamptz not null default now())`);
  await db.execute(sql`create table if not exists share_cards (id text primary key, kind text not null, counts jsonb not null, generated_at_ms bigint not null, created_at_ms bigint not null)`);
}

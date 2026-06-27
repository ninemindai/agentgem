// src/aggregator/db.ts
import { PGlite } from "@electric-sql/pglite";

export type DB = PGlite;

/** Production Postgres DDL — validated on pglite here, identical on hosted Postgres later. */
export const SCHEMA = `
create table if not exists producers (
  pubkey       text primary key,
  first_seen   timestamptz not null default now(),
  attest_count int not null default 0
);
create table if not exists attestations (
  id              uuid primary key,
  gem_name        text not null,
  gem_digest      text not null unique,
  producer_pubkey text not null references producers(pubkey),
  harness_id      text not null,
  models          text[] not null default '{}',
  scan_sessions   int not null,
  scan_span_days  int not null,
  signal_digest   text not null,
  private_count   int not null default 0,
  trust_score     real not null default 1,
  quarantined     boolean not null default false,
  ingested_at     timestamptz not null default now()
);
create table if not exists ingredients (
  id           text primary key,
  kind         text not null,
  id_kind      text not null,
  display_name text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);
create table if not exists usage_edges (
  attestation_id uuid not null references attestations(id),
  ingredient_id  text not null references ingredients(id),
  invocations    int  not null,
  sessions       int  not null,
  primary key (attestation_id, ingredient_id)
);
`;

export async function createDb(): Promise<DB> {
  const db = await PGlite.create();
  await db.exec(SCHEMA);
  return db;
}

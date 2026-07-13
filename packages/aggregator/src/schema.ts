// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { pgTable, text, integer, uuid, timestamp, boolean, real, primaryKey, jsonb, bigint, customType, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { isUniqueViolation } from "./handles.js";

export const producers = pgTable("producers", {
  pubkey: text("pubkey").primaryKey(),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  attestCount: integer("attest_count").notNull().default(0),
});
export const attestations = pgTable("attestations", {
  id: uuid("id").primaryKey(),
  gemName: text("gem_name").notNull(),
  // Uniqueness is per (gem_digest, producer_pubkey), NOT gem_digest alone: two legitimate producers
  // of the same gem binary each keep their own attestation (the aggregates count distinct producers).
  gemDigest: text("gem_digest").notNull(),
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
}, (t) => [uniqueIndex("attestations_gem_digest_producer_key").on(t.gemDigest, t.producerPubkey)]);
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

// Per-(attestation, model) outcome counts from a formatVersion-2 attestation's
// source.outcomeHistogram. Aggregated across producers (k-anon) into the
// cross-model benchmark.
export const modelOutcomes = pgTable("model_outcomes", {
  attestationId: uuid("attestation_id").notNull().references(() => attestations.id),
  model: text("model").notNull(),
  mostly: integer("mostly").notNull(),
  partially: integer("partially").notNull(),
  notAchieved: integer("not_achieved").notNull(),
}, (t) => [primaryKey({ columns: [t.attestationId, t.model] })]);

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
  counts: jsonb("counts").$type<{ breadth: number; battleTested: number; portable: number }>(),
  payload: jsonb("payload").$type<{ name: string; provenance: string }>(),
  generatedAtMs: bigint("generated_at_ms", { mode: "number" }).notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey(),
  keyHash: text("key_hash").notNull().unique(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  login: text("login"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Single-use, short-TTL codes for the desktop→web SSO handoff. The local app mints a code (bearer-
// authenticated), opens the redeem URL in the browser, and the redeem route swaps the code for a
// fresh web session cookie. Only the code's sha256 is stored, and it maps to an account (never a
// live token), so a leaked row can't be replayed into a session on its own.
export const handoffCodes = pgTable("handoff_codes", {
  codeHash: text("code_hash").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Short-lived, one-time record binding an in-flight Flow B connect-OAuth (its PKCE `code_verifier`)
// to the caller's session user, so the later callback can prove who started the flow. `state_hash`
// is sha256(state) — never store the raw state (mirrors handoffCodes). Consumed (deleted) on read.
export const connectStates = pgTable("connect_states", {
  stateHash: text("state_hash").primaryKey(),
  codeVerifier: text("code_verifier").notNull(),
  currentUserId: text("current_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const stars = pgTable("stars", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Written user reviews (rating + prose) on a target. Generic (kind + text id), no FK to the
// target — same shape as `stars`, but reviews carry content so they key on the concrete catalog
// skill (kind "skill", id "<sourceId>/<path>"), NOT the lossy skill-name id stars use.
export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  rating: integer("rating").notNull(),
  body: text("body"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gemAdoptions = pgTable("gem_adoptions", {
  gemKey: text("gem_key").notNull(),
  gemDigest: text("gem_digest").notNull(),
  producerPubkey: text("producer_pubkey").notNull().references(() => producers.pubkey),
  accountLogin: text("account_login"),
  event: text("event").notNull().default("install"),
  adoptedAt: timestamp("adopted_at", { withTimezone: true }).notNull().defaultNow(),
  trustScore: real("trust_score").notNull().default(1),
  quarantined: boolean("quarantined").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.gemKey, t.producerPubkey] })]);

// `capturedAt` timestamps each capture (scopes are REPLACED wholesale at sign-in/bind), so
// membership-gated reads can demand freshness: a member removed from the GitHub org stops passing
// once their capture ages out, instead of coasting on a months-old grant. `role` mirrors GitHub's
// org role at capture ("admin" | "member"; "self" for the login's own scope) — read surfaces don't
// gate on it, but future org-admin actions (settings, retention, member ops) will.
export const accountScopes = pgTable("account_scopes", {
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  scope: text("scope").notNull(),
  role: text("role").notNull().default("member"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.accountId, t.scope] })]);

// Self-reported daily usage rollups (tokens/sessions/duration) pushed on a schedule by the local
// agentgem process, keyed to the signed-in account. One row per (account, machine, repo-owner
// scope, UTC day) so a re-report of the same window is an idempotent upsert and multi-machine
// users don't clobber each other's days. `scope` is the lowercased owner of the repo the work
// happened in (from the local git remote; "" = unattributed) — the org dashboard only aggregates
// its own scope, so personal/other-org work never leaks into it. `date` is a UTC "YYYY-MM-DD"
// string (lexicographic order == chronological order). Token columns are bigints: a single heavy
// user crosses int4 within months.
export const usageDays = pgTable("usage_days", {
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  machine: text("machine").notNull().default("default"),
  scope: text("scope").notNull().default(""),
  date: text("date").notNull(),
  sessions: integer("sessions").notNull().default(0),
  msgs: integer("msgs").notNull().default(0),
  tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
  tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
  tokensCache: bigint("tokens_cache", { mode: "number" }).notNull().default(0),
  activeMs: bigint("active_ms", { mode: "number" }).notNull().default(0),
  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.accountId, t.machine, t.scope, t.date] })]);

// Per-(agent, model) slice of a usage day — the "By Model" / "By Agent" breakdown. Kept in a side
// table (not extra usage_days columns) so the day rollup stays cheap and the model cardinality
// can't distort the leaderboard math. Same idempotent-upsert + scope-attribution semantics.
export const usageDayModels = pgTable("usage_day_models", {
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  machine: text("machine").notNull().default("default"),
  scope: text("scope").notNull().default(""),
  date: text("date").notNull(),
  agent: text("agent").notNull().default(""),
  model: text("model").notNull().default(""),
  sessions: integer("sessions").notNull().default(0),
  tokens: bigint("tokens", { mode: "number" }).notNull().default(0),
  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.accountId, t.machine, t.scope, t.date, t.agent, t.model] })]);

// Per-org dashboard settings, admin-writable (account_scopes.role = 'admin'). `retentionDays`
// null = keep usage forever; otherwise reports + reads prune this org's usage rows past the window.
export const orgSettings = pgTable("org_settings", {
  scope: text("scope").primaryKey(),
  retentionDays: integer("retention_days"),
  dashboardEnabled: boolean("dashboard_enabled").notNull().default(true),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// GitHub App installations (one row per installed org) + the member lists they sync. Written by
// the src/githubApp webhook/reconcile path; read by resolveOrgAccess as the authoritative
// membership gate. org_scope and gh_login are lowercased at write time (case-insensitive gate).
export const appInstallations = pgTable("app_installations", {
  installationId: bigint("installation_id", { mode: "number" }).primaryKey(),
  orgScope: text("org_scope").notNull(),
  repoSelection: text("repo_selection").notNull().default("selected"),
  suspended: boolean("suspended").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgMembers = pgTable("org_members", {
  orgScope: text("org_scope").notNull(),
  ghLogin: text("gh_login").notNull(),
  role: text("role").notNull().default("member"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.orgScope, t.ghLogin] })]);

// A group is a set of accounts that can be granted access together.
//
//   kind 'federated' — mirrors an external network. Identity is `installation_id` (survives GitHub
//                      org renames); `scope` is MUTABLE display/lookup metadata, not the key.
//   kind 'native'    — created inside AgentGem. No installation, no scope, uuid-addressed.
//
// The check constraint IS the definition: a federated group is exactly one with an installation.
export const groups = pgTable("groups", {
  id: uuid("id").primaryKey(),
  kind: text("kind").notNull(),
  installationId: bigint("installation_id", { mode: "number" }).unique(),
  scope: text("scope").unique(),
  name: text("name").notNull(),
  createdBy: uuid("created_by").references(() => accounts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Membership is a LATTICE of two independent grants, not one `source` enum.
//
//   via_sync   — owned exclusively by the GitHub App reconciler (Plan 1b)
//   via_invite — owned exclusively by a group admin
//
// Neither authority may clear the other's bit. The row exists while either bit is set, and is
// deleted when both clear. This is what lets an invited contractor who was later hired into the
// org keep their guest access after they leave the company: leaving clears via_sync, and via_invite
// still stands. A single `source` column would have destroyed that grant on the first sync.
//
// Effective role = max(sync_role, invite_role), admin > member.
export const groupMembers = pgTable("group_members", {
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  viaSync: boolean("via_sync").notNull().default(false),
  viaInvite: boolean("via_invite").notNull().default(false),
  syncRole: text("sync_role"),
  inviteRole: text("invite_role"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.groupId, t.accountId] })]);

// Multi-use until expiry or revocation — a link pasted into a chat, not a one-shot machine code.
// `id` is the public handle: it is what an admin sees, and what revoke takes. Only sha256(token)
// is stored, so a DB leak cannot join a group, and revocation never needs the raw token back.
// (Contrast handoff_codes, which is delete-on-read; the storage discipline is shared, not the
// lifecycle.)
export const groupInvites = pgTable("group_invites", {
  id: uuid("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdBy: uuid("created_by").notNull().references(() => accounts.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// Additive ACL: which groups a private gem (by key, all versions) is shared with. A member of any
// listed group may access the gem's private versions (see accountCanAccessGem). Group deletion
// cascades these rows; gem deletion cleans them via deleteCatalogGem.
export const gemGroupShares = pgTable("gem_group_shares", {
  gemKey: text("gem_key").notNull(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").notNull().references(() => accounts.id),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.gemKey, t.groupId] })]);

export const catalogGems = pgTable("catalog_gems", {
  gemKey: text("gem_key").notNull(),
  version: text("version").notNull(),
  publishedBy: text("published_by").notNull(),
  author: text("author"),
  description: text("description"),
  tags: jsonb("tags").$type<string[]>(),
  artifactKinds: jsonb("artifact_kinds").$type<string[]>(),
  type: text("type"),
  grade: integer("grade"),
  // Per-artifact list (name + type) for the marketplace contents preview — set by the archive
  // publish path. Distinct from artifactKinds (the deduped kind summary).
  artifacts: jsonb("artifacts").$type<{ name: string; type: string }[]>(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  // Last-write time for this (key, version) row. An overwrite-publish preserves created_at_ms and
  // bumps this; a new-version publish inserts a fresh row with both equal. Nullable for rows written
  // before the column existed — readers coalesce a null back to created_at_ms.
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }),
  ownerAccountId: uuid("owner_account_id"),
  // Sharing scope. 'public' = listed in Explore; 'unlisted' = hidden from Explore but reachable by
  // its /games/<key> link; 'private' = owner-only (enforcement lands in PR 2b). Default public.
  visibility: text("visibility").notNull().default("public"),
}, (t) => [primaryKey({ columns: [t.gemKey, t.version] })]);

// Installable gem content: the .gem archive bytes for a published (gem_key, version). A row here
// makes the matching catalog_gems row installable; the public download streams these bytes.
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (v) => Buffer.from(v),
  fromDriver: (v) => new Uint8Array(v),
});
export const gemArchives = pgTable("gem_archives", {
  gemKey: text("gem_key").notNull(),
  version: text("version").notNull(),
  bytes: bytea("bytes").notNull(),
  size: integer("size").notNull(),
  digest: text("digest").notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  ownerAccountId: uuid("owner_account_id").references(() => accounts.id),
}, (t) => [primaryKey({ columns: [t.gemKey, t.version] })]);

// Per-(gem_key, version) cover image for OG cards — a screenshot captured at publish time. Cosmetic:
// NOT part of the signed manifest/gemDigest. Streamed only as pixels composited inside /og/card.png.
export const gemCovers = pgTable("gem_covers", {
  gemKey: text("gem_key").notNull(),
  version: text("version").notNull(),
  bytes: bytea("bytes").notNull(),
  contentType: text("content_type").notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.gemKey, t.version] })]);

export type ReviewStatus = "open" | "approved" | "changes-requested" | "withdrawn";

// A staging gem under review. Bytes + manifest live HERE, isolated from every published surface
// (catalog_gems / gem_archives), until approval publishes through the normal upsert functions.
// Ownership/authorship is the accounts.id uuid, never a login string. Timestamps are epoch-ms
// bigints (matching the gem tables) so store fns take an explicit `now` and tests stay deterministic.
export const reviewRequests = pgTable("review_requests", {
  id: uuid("id").primaryKey(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  gemKey: text("gem_key").notNull(),
  version: text("version").notNull(),
  authorAccountId: uuid("author_account_id").notNull().references(() => accounts.id),
  status: text("status").$type<ReviewStatus>().notNull().default("open"),
  description: text("description"),
  manifest: jsonb("manifest").notNull(),          // the CatalogManifest to publish on approval
  archiveBytes: bytea("archive_bytes"),           // .gem bytes; nulled on approve/withdraw
  archiveDigest: text("archive_digest").notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  resolvedAtMs: bigint("resolved_at_ms", { mode: "number" }),
}, (t) => [index("review_requests_group_idx").on(t.groupId)]);

export const reviewMessages = pgTable("review_messages", {
  id: uuid("id").primaryKey(),
  requestId: uuid("request_id").notNull().references(() => reviewRequests.id, { onDelete: "cascade" }),
  authorAccountId: uuid("author_account_id").notNull().references(() => accounts.id),
  body: text("body").notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [index("review_messages_request_idx").on(t.requestId)]);

// Read-tracking marker: when this account last opened this request. Drives the inbox unread badge.
export const reviewSeen = pgTable("review_seen", {
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  requestId: uuid("request_id").notNull().references(() => reviewRequests.id, { onDelete: "cascade" }),
  lastSeenAtMs: bigint("last_seen_at_ms", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.accountId, t.requestId] })]);

// Append-only: one row per click into a mini-game's fullscreen play (POST /api/aggregator/game-play).
// A play is a CLICK, not a person — the arcade needs no login, so this table can never answer "how many
// unique users". `visitorId` is an opaque localStorage uuid the SPA mints: a dedupe key for checking a
// count against distinct browsers, NOT an identity. Never surface it as "users". Null when the client
// sends none (older SPA, curl, bots). The write is unauthenticated, so the count is analytics-pixel
// grade — anyone willing to replay the POST can inflate it.
export const gamePlays = pgTable("game_plays", {
  id: uuid("id").primaryKey(),
  gemKey: text("gem_key").notNull(),
  version: text("version").notNull(),
  visitorId: text("visitor_id"),
  playedAt: timestamp("played_at", { withTimezone: true }).notNull().defaultNow(),
});

// Skills discovered across the curated sources (@agentgem/distribute CURATED_SOURCES), indexed by
// curatedSkillsIndexer for the marketplace "Popular Skills" board. `sourceLabel` duplicates the
// source's display label (rather than joining back to the static CURATED_SOURCES list at read
// time) so the read path is a single table scan. `installs` is reserved for a later skills.sh
// enrichment pass and is intentionally left untouched by the indexer's upsert.
export const curatedSkills = pgTable("curated_skills", {
  sourceId: text("source_id").notNull(),
  path: text("path").notNull(),
  division: text("division").notNull(),
  name: text("name").notNull(),
  repo: text("repo").notNull(),
  sourceLabel: text("source_label").notNull(),
  homepage: text("homepage"),
  stars: integer("stars").notNull().default(0),
  installs: integer("installs"),
  description: text("description"),
  // Non-null = a private org source row (GitHub App), visible only to that org's members.
  orgScope: text("org_scope"),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.sourceId, t.path] })]);

// better-auth core tables (Plan 1a): pgTable objects the drizzleAdapter resolves its models
// against (keyed by these exact export names — "user", "session", "account", "verification" —
// via db._.fullSchema). DDL lives in ensureSchema below; these are additive, read/written only by
// better-auth. name/email are nullable (NOT the generator's default) to match that DDL — GitHub
// logins are often email-less and a NOT NULL email would hard-fail sign-in.
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  login: text("login"),
  // NOT `.unique()`: the DDL authority (ensureSchema, below) enforces uniqueness case-insensitively
  // via a `unique index on (lower(handle))`, not a plain per-value unique constraint — declaring
  // `.unique()` here would claim a stronger-but-wrong guarantee (drizzle's own metadata, unused by
  // any query in this codebase) than what's actually enforced at the DB level.
  handle: text("handle"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("account_provider_idx").on(t.providerId, t.accountId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// better-auth passkey plugin (@better-auth/passkey). JS property names MUST match the plugin's model
// field names exactly (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp,
// transports, aaguid, createdAt) so the drizzle adapter resolves the model; columns are snake_case
// per house style. DDL authority is ensureSchema below.
export const passkey = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull().default(0),
    deviceType: text("device_type"),
    backedUp: boolean("backed_up"),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("passkey_user_idx").on(t.userId), index("passkey_credential_idx").on(t.credentialID)],
);

// Account-linking Flow B seam (Task 0 spike, seam b): better-auth's linkSocial does NOT persist the
// server-resolved identity of a provider it rejects as "already linked to a different user" (its
// OAuth callback redirects without a DB write). So Flow B cannot piggyback on linkSocial's rejection;
// a bespoke connect-OAuth callback (Task 6) resolves the other provider's identity itself and stashes
// it HERE — one short-lived row per session user (PK), read back by `pendingLink` scoped to the
// caller's session. `session_user_id` is the server-verified session subject, never a request body.
export const pendingAccountLinks = pgTable("pending_account_links", {
  sessionUserId: text("session_user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const schema = { producers, attestations, ingredients, usageEdges, modelOutcomes, accountBindings, shareCards, apiKeys, accounts, handoffCodes, stars, reviews, gemAdoptions, accountScopes, usageDays, usageDayModels, orgSettings, catalogGems, gemArchives, gamePlays, curatedSkills, appInstallations, orgMembers, groups, groupMembers, groupInvites, gemGroupShares, reviewRequests, reviewMessages, reviewSeen, user, session, account, verification, pendingAccountLinks, connectStates, passkey };
export type AppDb = PgDatabase<any, typeof schema>;

/** One-time, idempotent: give every account_binding with no matching `accounts` anchor row one,
 *  copying provider/account_id/login off the binding. recordBinding's own upsertAccount write is
 *  best-effort (see binding.ts) — it never fails the bind — so a bound producer can be left with
 *  no anchor and fail closed on every future share ("not-connected"), even though everything the
 *  anchor needs (provider, the provider's account id, and the login) already lives on the
 *  binding row. `unique (provider, provider_account_id)` on accounts is the race arbiter; the
 *  `on conflict ... do nothing` makes concurrent boots safe. Never touches an existing anchor
 *  row — its accounts.id must never change once assigned (better-auth's user.id mirrors it 1:1
 *  after migrateAccountsToBetterAuth, so re-keying it here would silently orphan that user). */
export async function backfillBindingAnchors(db: AppDb): Promise<{ created: number }> {
  const res = await db.execute(sql`
    insert into accounts (id, provider, provider_account_id, login)
    select gen_random_uuid(), ab.provider, ab.account_id, ab.account_login
    from account_bindings ab
    where not exists (
      select 1 from accounts a
      where a.provider = ab.provider and a.provider_account_id = ab.account_id)
    on conflict (provider, provider_account_id) do nothing`);
  return { created: (res as any).rowCount ?? (res as any).affectedRows ?? 0 };
}

/** One-time, idempotent: map catalog_gems.published_by (a login string) onto owner_account_id.
 *  accounts.login has NO unique constraint, so assign ONLY where exactly one account matches —
 *  a naive join would silently hand the gem to whichever duplicate the planner returned first.
 *  Rows that do not resolve keep owner_account_id = NULL and are owned by NOBODY (fail closed). */
export async function backfillGemOwners(db: AppDb): Promise<{ resolved: number; unresolved: number }> {
  await db.execute(sql`
    update catalog_gems cg set owner_account_id = m.id
    from (select lower(login) lg, min(id::text)::uuid id from accounts
          where login is not null
          group by lower(login) having count(*) = 1) m
    where m.lg = lower(cg.published_by) and cg.owner_account_id is null`);
  const r = await db.execute(sql`select count(*) filter (where owner_account_id is null)::int as unresolved, count(*)::int as total from catalog_gems`);
  const { unresolved, total } = (r.rows as { unresolved: number; total: number }[])[0];
  return { resolved: total - unresolved, unresolved };
}

/** One-time, idempotent: claim `"user".handle = "user".login` for every existing GitHub user, so
 *  a user who signed up before handles existed is already claimed and never sees the claim flow
 *  ("Existing GitHub users' handles are backfilled from their login and are already claimed" —
 *  design doc). Modeled on backfillGemOwners' duplicate guard for the same reason: `"user".login`
 *  has no unique constraint, so a naive claim would non-deterministically hand the name to
 *  whichever duplicate the planner returns first. Assign only where ALL of:
 *    - the account's handle is still NULL (never overwrites an existing claim/rename)
 *    - the login is unambiguous: exactly one "user" row has it, case-insensitively
 *    - the login matches the handle charset (defensively — GitHub logins already do, but the
 *      CHECK constraint must never abort a boot over one that somehow doesn't)
 *    - the name isn't already claimed as someone else's handle
 *    - the name isn't reserved (a known org in org_members/org_settings) — on GitHub the user and
 *      org namespaces are shared upstream, so this should never fire, but don't assume it
 *  A single atomic UPDATE, so concurrent boots are safe under READ COMMITTED: a second run's WHERE
 *  re-evaluates against the first run's already-committed rows (handle no longer NULL), rather
 *  than racing the unique index the way a per-row claim would.
 *  `claimed` is per-call (0 on a re-run, like backfillBindingAnchors' `created`); `skipped` is the
 *  total still-unclaimed count so an operator can see backlog, like backfillGemOwners' `unresolved`.
 *
 *  Runs inside ensureSchema on every boot, so it must never abort a boot (like backfillBindingAnchors
 *  above). Unlike that backfill, this is an UPDATE, not an INSERT, so there is no `on conflict do
 *  nothing` to let the database arbitrate a lost race — a concurrent claimHandle rename that commits
 *  between this statement's snapshot read and its write attempt raises 23505 (unique violation on
 *  user_handle_uniq), which would otherwise propagate out of ensureSchema and fail startup over a
 *  condition that heals itself on the very next boot. Narrow the catch to that one SQLSTATE
 *  (isUniqueViolation, shared with handles.ts rather than re-deriving it) so a genuinely different
 *  failure (a deadlock, a lost connection) still propagates. */
export async function backfillUserHandles(db: AppDb): Promise<{ claimed: number; skipped: number }> {
  let claimed = 0;
  try {
    const res = await db.execute(sql`
      update "user" u set handle = m.login
      from (
        select lower(login) as lg, min(login) as login
        from "user"
        where login is not null and login ~ '^[A-Za-z0-9-]{1,39}$'
        group by lower(login)
        having count(*) = 1
      ) m
      where lower(u.login) = m.lg
        and u.handle is null
        and not exists (select 1 from "user" u2 where lower(u2.handle) = m.lg)
        and not exists (select 1 from org_members om where lower(om.org_scope) = m.lg)
        and not exists (select 1 from org_settings os where lower(os.scope) = m.lg)`);
    claimed = (res as any).rowCount ?? (res as any).affectedRows ?? 0;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost the race: the whole statement rolled back (nothing claimed this call), and the next
    // boot's re-run re-reads committed state, so this self-heals. claimed stays 0.
  }
  const r = await db.execute(sql`select count(*)::int as skipped from "user" where login is not null and handle is null`);
  const { skipped } = (r.rows as { skipped: number }[])[0];
  return { claimed, skipped };
}

/** better-auth requires a non-null email STRING in both user creation AND linkSocial's OAuth state
 *  (`link.email: z.string()`) — but GitHub logins are frequently email-less (see the `"user".email`
 *  nullable-column comment), so a null-email account throws an unhandled `internal_server_error` on
 *  the Connect (linkSocial) callback. Give every email-less user GitHub's noreply address, keyed on
 *  their login (or uuid id when login is null), so `email` is a stable, unique, non-null string.
 *  Runs inside ensureSchema every boot; idempotent (a no-op once drained). Like backfillUserHandles,
 *  narrow the catch to a unique violation (email is UNIQUE) so a benign collision self-heals on the
 *  next boot while a genuinely different failure still propagates. */
export async function backfillUserEmails(db: AppDb): Promise<{ filled: number }> {
  let filled = 0;
  try {
    const res = await db.execute(sql`
      update "user" set email = coalesce(login, id) || '@users.noreply.github.com'
      where email is null`);
    filled = (res as { rowCount?: number; affectedRows?: number }).rowCount ?? (res as { affectedRows?: number }).affectedRows ?? 0;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  return { filled };
}

// Idempotent DDL. (Schema-as-tables above is the query source of truth; this DDL
// creates them. A column drift is caught immediately by the typed drizzle inserts.
// drizzle-kit migrations are a deferred follow-up when the schema starts evolving.)
export async function ensureSchema(db: AppDb): Promise<void> {
  await db.execute(sql`create table if not exists producers (pubkey text primary key, first_seen timestamptz not null default now(), attest_count int not null default 0)`);
  await db.execute(sql`create table if not exists attestations (id uuid primary key, gem_name text not null, gem_digest text not null, producer_pubkey text not null references producers(pubkey), harness_id text not null, models text[] not null default '{}', scan_sessions int not null, scan_span_days int not null, signal_digest text not null, private_count int not null default 0, trust_score real not null default 1, quarantined boolean not null default false, ingested_at timestamptz not null default now())`);
  // Re-key: uniqueness is per (gem_digest, producer_pubkey), not gem_digest alone, so two producers of
  // the same gem binary each keep their own attestation. Drop the old single-column unique on existing
  // DBs (auto-named attestations_gem_digest_key) and add the composite. Both idempotent.
  await db.execute(sql`alter table attestations drop constraint if exists attestations_gem_digest_key`);
  await db.execute(sql`create unique index if not exists attestations_gem_digest_producer_key on attestations (gem_digest, producer_pubkey)`);
  await db.execute(sql`create table if not exists ingredients (id text primary key, kind text not null, id_kind text not null, display_name text, first_seen timestamptz not null default now(), last_seen timestamptz not null default now())`);
  await db.execute(sql`create table if not exists usage_edges (attestation_id uuid not null references attestations(id), ingredient_id text not null references ingredients(id), invocations int not null, sessions int not null, primary key (attestation_id, ingredient_id))`);
  await db.execute(sql`create table if not exists model_outcomes (attestation_id uuid not null references attestations(id), model text not null, mostly int not null, partially int not null, not_achieved int not null, primary key (attestation_id, model))`);
  await db.execute(sql`create table if not exists account_bindings (pubkey text primary key references producers(pubkey), provider text not null, account_id text not null, account_login text not null, bound_at timestamptz not null default now())`);
  await db.execute(sql`create table if not exists share_cards (id text primary key, kind text not null, counts jsonb not null, generated_at_ms bigint not null, created_at_ms bigint not null)`);
  await db.execute(sql`alter table share_cards add column if not exists payload jsonb`);
  await db.execute(sql`alter table share_cards alter column counts drop not null`);
  await db.execute(sql`create table if not exists api_keys (id uuid primary key, key_hash text not null unique, label text not null, created_at timestamptz not null default now(), revoked_at timestamptz)`);
  await db.execute(sql`create table if not exists accounts (id uuid primary key, provider text not null, provider_account_id text not null, login text not null, avatar_url text, created_at timestamptz not null default now(), unique (provider, provider_account_id))`);
  await db.execute(sql`create table if not exists handoff_codes (code_hash text primary key, account_id uuid not null references accounts(id), expires_at timestamptz not null)`);
  await db.execute(sql`create table if not exists stars (id uuid primary key, account_id uuid not null references accounts(id), target_kind text not null, target_id text not null, created_at timestamptz not null default now(), unique (account_id, target_kind, target_id))`);
  await db.execute(sql`create index if not exists stars_target_idx on stars (target_kind, target_id)`);
  await db.execute(sql`create table if not exists reviews (id uuid primary key, account_id uuid not null references accounts(id), target_kind text not null, target_id text not null, rating int not null check (rating between 1 and 5), body text check (body is null or char_length(body) <= 4000), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (account_id, target_kind, target_id))`);
  await db.execute(sql`create index if not exists reviews_target_idx on reviews (target_kind, target_id)`);
  await db.execute(sql`create table if not exists gem_adoptions (gem_key text not null, gem_digest text not null, producer_pubkey text not null references producers(pubkey), account_login text, event text not null default 'install', adopted_at timestamptz not null default now(), trust_score real not null default 1, quarantined boolean not null default false, primary key (gem_key, producer_pubkey))`);
  // Added post-creation (quarantine + effectiveness feature): the CREATE above is a no-op on a
  // pre-existing table, so back-fill the columns any adoption/effectiveness/profile query reads.
  await db.execute(sql`alter table gem_adoptions add column if not exists trust_score real not null default 1`);
  await db.execute(sql`alter table gem_adoptions add column if not exists quarantined boolean not null default false`);
  await db.execute(sql`create table if not exists gem_covers (gem_key text not null, version text not null, bytes bytea not null, content_type text not null, created_at_ms bigint not null, primary key (gem_key, version))`);
  await db.execute(sql`create table if not exists account_scopes (account_id uuid not null references accounts(id), scope text not null, role text not null default 'member', captured_at timestamptz not null default now(), primary key (account_id, scope))`);
  await db.execute(sql`alter table account_scopes add column if not exists captured_at timestamptz not null default now()`);
  await db.execute(sql`alter table account_scopes add column if not exists role text not null default 'member'`);
  await db.execute(sql`create table if not exists usage_days (account_id uuid not null references accounts(id), machine text not null default 'default', scope text not null default '', date text not null, sessions int not null default 0, msgs int not null default 0, tokens_in bigint not null default 0, tokens_out bigint not null default 0, tokens_cache bigint not null default 0, active_ms bigint not null default 0, reported_at timestamptz not null default now(), primary key (account_id, machine, scope, date))`);
  await db.execute(sql`alter table usage_days add column if not exists scope text not null default ''`);
  // Re-key a pre-scope deployment's 3-column PK to include scope (idempotent: only fires when the
  // existing PK has 3 columns). Existing rows keep scope '' (unattributed) — the next report re-fills.
  await db.execute(sql`do $$ begin
    if (select count(*) from information_schema.key_column_usage where table_name = 'usage_days' and constraint_name = 'usage_days_pkey') = 3 then
      alter table usage_days drop constraint usage_days_pkey;
      alter table usage_days add primary key (account_id, machine, scope, date);
    end if;
  end $$`);
  await db.execute(sql`create index if not exists usage_days_date_idx on usage_days (date)`);
  await db.execute(sql`create table if not exists usage_day_models (account_id uuid not null references accounts(id), machine text not null default 'default', scope text not null default '', date text not null, agent text not null default '', model text not null default '', sessions int not null default 0, tokens bigint not null default 0, reported_at timestamptz not null default now(), primary key (account_id, machine, scope, date, agent, model))`);
  await db.execute(sql`create index if not exists usage_day_models_date_idx on usage_day_models (date)`);
  await db.execute(sql`create table if not exists org_settings (scope text primary key, retention_days int, dashboard_enabled boolean not null default true, updated_by text not null, updated_at timestamptz not null default now())`);
  await db.execute(sql`alter table org_settings add column if not exists dashboard_enabled boolean not null default true`);
  await db.execute(sql`create table if not exists catalog_gems (gem_key text not null, version text not null, published_by text not null, author text, description text, tags jsonb, artifact_kinds jsonb, type text, grade integer, created_at_ms bigint not null, primary key (gem_key, version))`);
  // Added post-creation (installable shared setups): the per-artifact preview list + the archive store.
  await db.execute(sql`alter table catalog_gems add column if not exists artifacts jsonb`);
  await db.execute(sql`alter table catalog_gems add column if not exists visibility text not null default 'public'`);
  // Last-write time; nullable so existing rows (created_at_ms only) migrate without a backfill.
  await db.execute(sql`alter table catalog_gems add column if not exists updated_at_ms bigint`);
  await db.execute(sql`create table if not exists gem_archives (gem_key text not null, version text not null, bytes bytea not null, size int not null, digest text not null, created_at_ms bigint not null, primary key (gem_key, version))`);
  await db.execute(sql`create table if not exists game_plays (id uuid primary key, gem_key text not null, version text not null, visitor_id text, played_at timestamptz not null default now())`);
  await db.execute(sql`create index if not exists game_plays_key_idx on game_plays (gem_key)`);
  await db.execute(sql`create table if not exists curated_skills (source_id text not null, path text not null, division text not null, name text not null, repo text not null, source_label text not null, homepage text, stars int not null default 0, installs int, indexed_at timestamptz not null default now(), primary key (source_id, path))`);
  await db.execute(sql`alter table curated_skills add column if not exists description text`);
  await db.execute(sql`alter table curated_skills add column if not exists org_scope text`);
  await db.execute(sql`create index if not exists curated_skills_org_idx on curated_skills (org_scope) where org_scope is not null`);
  await db.execute(sql`create index if not exists curated_skills_rank on curated_skills (stars desc)`);
  await db.execute(sql`create table if not exists app_installations (installation_id bigint primary key, org_scope text not null, repo_selection text not null default 'selected', suspended boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  await db.execute(sql`create index if not exists app_installations_scope_idx on app_installations (org_scope)`);
  await db.execute(sql`create table if not exists org_members (org_scope text not null, gh_login text not null, role text not null default 'member', synced_at timestamptz not null default now(), primary key (org_scope, gh_login))`);
  await db.execute(sql`create table if not exists groups (
    id uuid primary key,
    kind text not null check (kind in ('federated','native')),
    installation_id bigint unique,
    scope text unique,
    name text not null,
    created_by uuid references accounts(id),
    created_at timestamptz not null default now(),
    constraint groups_kind_installation check ((kind = 'federated') = (installation_id is not null))
  )`);
  await db.execute(sql`create table if not exists group_members (
    group_id uuid not null references groups(id) on delete cascade,
    account_id uuid not null references accounts(id),
    via_sync boolean not null default false,
    via_invite boolean not null default false,
    sync_role text check (sync_role in ('admin','member')),
    invite_role text check (invite_role in ('admin','member')),
    added_at timestamptz not null default now(),
    primary key (group_id, account_id),
    constraint group_members_some_grant check (via_sync or via_invite),
    constraint group_members_sync_role check (via_sync = (sync_role is not null)),
    constraint group_members_invite_role check (via_invite = (invite_role is not null))
  )`);
  await db.execute(sql`create index if not exists group_members_account_idx on group_members (account_id)`);
  await db.execute(sql`create table if not exists group_invites (
    id uuid primary key,
    token_hash text not null unique,
    group_id uuid not null references groups(id) on delete cascade,
    role text not null default 'member' check (role in ('admin','member')),
    expires_at timestamptz not null,
    created_by uuid not null references accounts(id),
    revoked_at timestamptz
  )`);
  await db.execute(sql`create table if not exists gem_group_shares (
    gem_key text not null,
    group_id uuid not null references groups(id) on delete cascade,
    created_by uuid not null references accounts(id),
    created_at_ms bigint not null,
    primary key (gem_key, group_id)
  )`);
  await db.execute(sql`create index if not exists group_invites_group_idx on group_invites (group_id)`);
  // Login → account lookup for the Plan 1b federated member sync. accounts.login keeps GitHub's casing.
  await db.execute(sql`create index if not exists accounts_login_lower_idx on accounts (lower(login))`);

  // better-auth core tables (Plan 1a): additive only, no existing behavior reads/writes these yet.
  // Reserved words ("user", "account", "session") are double-quoted.
  await db.execute(sql`create table if not exists "user" (
    id text primary key, name text, email text unique, email_verified boolean not null default false,
    image text, login text, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);

  // Identity re-key. `handle` is the ONLY human-readable name; it authorizes nothing, so it may
  // be NULL until claimed. Postgres UNIQUE permits many NULLs. NULL is not '', which makes the
  // empty-string identity collision unrepresentable rather than merely guarded.
  await db.execute(sql`alter table "user" add column if not exists handle text`);

  // The index is the race arbiter for claimHandle/claimHandleIfUnset (see handles.ts), which both
  // compare handles case-insensitively — so the index must too, or two concurrent claims of "bob"
  // and "Bob" both pass their own app-level guard on their own MVCC snapshot and both get admitted.
  // `create unique index if not exists` does NOT redefine an existing same-named index — it no-ops
  // — so a plain swap from the old `(handle)` definition would leave an already-deployed database
  // stuck on the case-sensitive index forever. Detect that stale definition by name and DROP it
  // before recreating under the SAME name (rather than parking the new one under a different name,
  // which would leave the old one behind consuming space/write cost with no reader left).
  //
  // If real data already has case-variant duplicates ("Bob" and "bob" both present), the CREATE
  // UNIQUE INDEX below fails outright — and this code does not try to silently pick a winner by
  // renaming or deleting either user's handle; that is not this migration's call to make. Detect
  // that case first and log loudly instead of letting the raw constraint-violation error propagate
  // out of ensureSchema and abort the boot. The stale case-sensitive index (if one exists) is left
  // in place so exact-match uniqueness keeps holding while an operator resolves the collision.
  const handleDupes = (await db.execute(sql`
    select count(*)::int as n from (
      select lower(handle) from "user" where handle is not null group by lower(handle) having count(*) > 1
    ) d`)).rows as { n: number }[];
  if ((handleDupes[0]?.n ?? 0) > 0) {
    console.error(`[schema] ${handleDupes[0].n} "user".handle value(s) collide case-insensitively — skipping the case-insensitive unique index (user_handle_uniq) until resolved manually; handle claims stay racy until then`);
  } else {
    const stale = await db.execute(sql`
      select 1 from pg_indexes
      where schemaname = 'public' and indexname = 'user_handle_uniq' and indexdef not ilike '%lower(handle)%'`);
    if ((stale.rows?.length ?? 0) > 0) {
      await db.execute(sql`drop index if exists user_handle_uniq`);
    }
    await db.execute(sql`create unique index if not exists user_handle_uniq on "user" (lower(handle))`);
  }
  await db.execute(sql`do $$ begin
    alter table "user" add constraint user_handle_shape
      check (handle is null or handle ~ '^[A-Za-z0-9-]{1,39}$');
  exception when duplicate_object then null; end $$`);

  // The authorization key for a published gem. NULL = owned by nobody (see the backfill).
  await db.execute(sql`alter table catalog_gems add column if not exists owner_account_id uuid references accounts(id)`);
  await db.execute(sql`create index if not exists catalog_gems_owner_idx on catalog_gems (owner_account_id)`);

  // Owner of an UNLISTED share archive (no catalog_gems row). NULL = owned by nobody (published
  // gems, whose ownership lives on catalog_gems). Same fail-closed rule as catalog_gems.
  await db.execute(sql`alter table gem_archives add column if not exists owner_account_id uuid references accounts(id)`);
  await db.execute(sql`create index if not exists gem_archives_owner_idx on gem_archives (owner_account_id)`);

  // A login-less provider (Google, Slack, X) must still get an `accounts` anchor row, because ten
  // tables carry a foreign key to accounts.id. See anchorAndScopes.
  await db.execute(sql`alter table accounts alter column login drop not null`);

  // Dead since the Plan 1b cutover: zero readers, sessions now live in better-auth's `session`.
  await db.execute(sql`drop table if exists web_sessions`);

  await db.execute(sql`create table if not exists "session" (
    id text primary key, user_id text not null references "user"(id) on delete cascade,
    token text not null unique, expires_at timestamptz not null, ip_address text, user_agent text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  await db.execute(sql`create index if not exists session_user_idx on "session"(user_id)`);
  await db.execute(sql`create table if not exists "account" (
    id text primary key, user_id text not null references "user"(id) on delete cascade,
    account_id text not null, provider_id text not null, access_token text, refresh_token text, id_token text,
    access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text, password text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  await db.execute(sql`create unique index if not exists account_provider_idx on "account"(provider_id, account_id)`);
  await db.execute(sql`create table if not exists "verification" (
    id text primary key, identifier text not null, value text not null, expires_at timestamptz not null,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  await db.execute(sql`create table if not exists "passkey" (
    id text primary key,
    name text,
    public_key text not null,
    user_id text not null references "user"(id) on delete cascade,
    credential_id text not null,
    counter integer not null default 0,
    device_type text,
    backed_up boolean,
    transports text,
    aaguid text,
    created_at timestamptz not null default now())`);
  await db.execute(sql`create index if not exists passkey_user_idx on "passkey"(user_id)`);
  await db.execute(sql`create index if not exists passkey_credential_idx on "passkey"(credential_id)`);
  // Flow B connect-OAuth handoff (Task 0 seam b): one short-lived pending link per session user.
  await db.execute(sql`create table if not exists "pending_account_links" (
    session_user_id text primary key references "user"(id) on delete cascade,
    provider_id text not null, provider_account_id text not null,
    expires_at timestamptz not null, created_at timestamptz not null default now())`);
  // Flow B connect-OAuth handoff: one short-lived, one-time record per in-flight state, binding its
  // PKCE code_verifier to the caller's session user (Task 1).
  await db.execute(sql`create table if not exists "connect_states" (
    state_hash text primary key,
    code_verifier text not null,
    current_user_id text not null references "user"(id) on delete cascade,
    provider text not null,
    expires_at timestamptz not null, created_at timestamptz not null default now())`);

  await db.execute(sql`create table if not exists review_requests (
    id uuid primary key,
    group_id uuid not null references groups(id) on delete cascade,
    gem_key text not null,
    version text not null,
    author_account_id uuid not null references accounts(id),
    status text not null default 'open' check (status in ('open','approved','changes-requested','withdrawn')),
    description text,
    manifest jsonb not null,
    archive_bytes bytea,
    archive_digest text not null,
    created_at_ms bigint not null,
    resolved_at_ms bigint
  )`);
  await db.execute(sql`create index if not exists review_requests_group_idx on review_requests (group_id)`);
  await db.execute(sql`create table if not exists review_messages (
    id uuid primary key,
    request_id uuid not null references review_requests(id) on delete cascade,
    author_account_id uuid not null references accounts(id),
    body text not null,
    created_at_ms bigint not null
  )`);
  await db.execute(sql`create index if not exists review_messages_request_idx on review_messages (request_id)`);
  await db.execute(sql`create table if not exists review_seen (
    account_id uuid not null references accounts(id),
    request_id uuid not null references review_requests(id) on delete cascade,
    last_seen_at_ms bigint not null,
    primary key (account_id, request_id)
  )`);

  // MUST run before backfillGemOwners: gem-owner resolution matches against `accounts`, and
  // migrateAccountsToBetterAuth (run at boot right after ensureSchema, see src/index.ts) mirrors
  // every `accounts` row into a same-id better-auth `user` row — an anchor created after either
  // step would resolve fewer gems and dodge the better-auth mirror entirely.
  await backfillBindingAnchors(db);

  // Placed right after the anchor backfill and before the gem-owner backfill: it has no functional
  // dependency on either (it reads/writes only "user", org_members, org_settings — none of which
  // backfillBindingAnchors or backfillGemOwners touch), but anchoring an account's EXISTENCE before
  // naming it reads in the same order the rollout narrative does ("existing users are already
  // claimed"), and gem-ownership resolution — the one with a security consequence for unresolved
  // rows (see the warning below) — stays adjacent to its own anchor dependency.
  await backfillUserHandles(db);

  // better-auth's linkSocial (Connect) bakes the caller's email into its OAuth state as a required
  // string, and user creation requires it too — but GitHub logins are often email-less, so a null
  // email throws an unhandled 500 on Connect. Give every email-less user a noreply address. Runs
  // after the handle backfill (both touch "user") but is independent of it; idempotent.
  await backfillUserEmails(db);

  // Drop the pre-re-key `role='self'` mirror rows. The account's own namespace is `"user".handle`
  // (just backfilled above), read directly by accountSelfScope/accountOwnsScope — a scope row
  // duplicating it is stale state with three disagreeing writers, which is exactly what let a CLI
  // `bind` revert a renamed handle. Ordered AFTER backfillUserHandles so every account that had a
  // self row has already been given the handle it names; deleting first would briefly leave a
  // GitHub user unable to publish under their own name.
  //
  // Idempotent (a no-op once drained) and non-load-bearing: accountOwnsScope / accountScopeInfo /
  // accountScopeRole all filter to `role in ('admin','member')` regardless, so a row that outlives
  // this delete still grants nothing. Org memberships (admin/member) are untouched.
  await db.execute(sql`delete from account_scopes where role = 'self'`);

  const owners = await backfillGemOwners(db);
  if (owners.unresolved > 0) {
    console.warn(`[schema] ${owners.unresolved} catalog_gems row(s) have no resolvable owner; they cannot be unpublished by anyone until reassigned`);
  }
}

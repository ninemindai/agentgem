// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// @agentgem/aggregator — Postgres/pglite data-moat: schema, aggregates, ingest, detection, account binding.
export * from "./schema.js";
export * from "./aggregates.js";
export * from "./detection.js";
export * from "./ingest.js";
export * from "./project.js";
export * from "./binding.js";
export * from "./accountVerifier.js";
export * from "./seed.js";
export * from "./testDb.js";
export * from "./apiKeys.js";
export * from "./localDb.js";
export * from "./webAuth.js";
export * from "./stars.js";
export * from "./reviews.js";
export * from "./projectAdoption.js";
export * from "./ingestAdoption.js";
export * from "./catalog.js";
export * from "./gamePlays.js";
export * from "./profile.js";
export * from "./orgRubric.js";
export * from "./orgCatalog.js";
export * from "./usageDays.js";
export * from "./orgSettings.js";
export * from "./curatedSkills.js";
export * from "./githubApp.js";
export * from "./groups.js";
export * from "./groupInvites.js";
export * from "./handles.js";
export * from "./auth/betterAuth.js";
export * from "./auth/mintSession.js";
export * from "./auth/mintCookie.js";
export * from "./auth/migrateAccounts.js";
// NOTE: ./auth/testCookie.js is intentionally NOT re-exported here — it's a test-only helper that
// builds a throwaway better-auth instance with emailAndPassword enabled, and has no business in the
// production import graph. Tests import it via the "@agentgem/aggregator/testing" subpath instead.

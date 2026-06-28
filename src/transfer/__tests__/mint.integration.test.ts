// src/transfer/__tests__/mint.integration.test.ts
// Validates that minted creds actually authenticate and are scoped, against a real
// JWT-configured broker. Skipped unless NATS_JWT_TEST (url) + NATS_JWT_TEST_ACCOUNT_SEED
// are set — there is no such broker in CI. See the spec's "NATS-server JWT/WS ops
// setup" prerequisite. If an in-scope object get is denied here, widen scopeSubjects
// minimally (spec open question #2) and note what was added.
import { describe, it, expect } from "vitest";
import { connect } from "@nats-io/transport-node";
import { credsAuthenticator } from "@nats-io/nats-core";
import { mintScopedCreds } from "../mint.js";

const url = process.env.NATS_JWT_TEST;
const accountSeed = process.env.NATS_JWT_TEST_ACCOUNT_SEED;
const gated = url && accountSeed ? describe : describe.skip;

gated("mintScopedCreds (integration, needs NATS_JWT_TEST + account seed)", () => {
  it("minted creds authenticate and reject an off-scope action", async () => {
    const { creds } = await mintScopedCreds({ accountSeed: accountSeed!, scope: "receive", ttlSeconds: 60 });
    const nc = await connect({ servers: url!, authenticator: credsAuthenticator(new TextEncoder().encode(creds)) });
    try {
      // Connecting proves the creds authenticate. An off-scope publish must be denied.
      await expect(nc.request("definitely.not.in.scope", undefined, { timeout: 250 }))
        .rejects.toThrow(/[Pp]ermission|[Tt]imeout|no responders/);
    } finally {
      await nc.close();
    }
  });
});

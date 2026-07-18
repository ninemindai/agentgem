import { describe, it, expect } from "vitest";
import {
  clampGrade,
  catalogSigningPayload,
  gemStatusSigningPayload,
  myGemsSigningPayload,
  reviewActionPayload,
  reviewSubmitPayload,
  reviewResubmitPayload,
  type CatalogManifest,
} from "../index.js";
import { bindSigningPayload } from "../index.js";  // add to the existing import list

describe("@agentgem/contract catalog surface", () => {
  it("clampGrade floors to 1..3 and is NaN-safe", () => {
    expect(clampGrade(0)).toBe(1);
    expect(clampGrade(5)).toBe(3);
    expect(clampGrade(2)).toBe(2);
    expect(clampGrade(undefined)).toBeUndefined();
    expect(clampGrade(NaN)).toBeUndefined();
  });

  it("signing payloads are deterministic canonical strings that commit to their inputs", () => {
    const m: CatalogManifest = { gemKey: "a/b", version: "1.0.0" };
    const p1 = catalogSigningPayload(m, "pk", 1000);
    const p2 = catalogSigningPayload(m, "pk", 1000);
    expect(p1).toBe(p2);                                   // deterministic
    expect(catalogSigningPayload(m, "pk", 1001)).not.toBe(p1); // commits to signedAt
    expect(gemStatusSigningPayload("a/b", "pk", 1000)).toContain("a/b");
    expect(myGemsSigningPayload("pk", 1000)).toContain("my-gems");
    expect(reviewActionPayload("approve", "req1", "pk", 1000)).toContain("approve");
    expect(reviewSubmitPayload(m, "g1", "pk", 1000)).toContain("review-submit");
    expect(reviewResubmitPayload(m, "req1", "pk", 1000)).toContain("review-resubmit");
  });
});

describe("@agentgem/contract binding surface", () => {
  it("bindSigningPayload hashes the token (never signs it raw) and is deterministic", () => {
    const p = bindSigningPayload("pk", "secret-token", 1000);
    expect(p).toBe(bindSigningPayload("pk", "secret-token", 1000)); // deterministic
    expect(p).not.toContain("secret-token");                        // token is hashed, not raw
    expect(bindSigningPayload("pk", "other", 1000)).not.toBe(p);    // commits to the token
  });
});

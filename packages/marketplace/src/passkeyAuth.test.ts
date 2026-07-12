// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { passkeySupported, makePasskeyAuth } from "./passkeyAuth";

describe("passkeyAuth", () => {
  const orig = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  afterEach(() => {
    if (orig === undefined) delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    else (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = orig;
  });

  it("passkeySupported reflects PublicKeyCredential availability", () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
    expect(passkeySupported()).toBe(true);
    delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    expect(passkeySupported()).toBe(false);
  });

  it("makePasskeyAuth exposes the passkey ceremony surface", () => {
    const client = makePasskeyAuth("https://api.example.test");
    expect(typeof client.signIn.passkey).toBe("function");
    expect(typeof client.passkey.addPasskey).toBe("function");
    expect(typeof client.passkey.listUserPasskeys).toBe("function");
    expect(typeof client.passkey.deletePasskey).toBe("function");
  });
});

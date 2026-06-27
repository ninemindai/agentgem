// src/gem/identity.ts
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Identity { publicKey: string; sign(data: string): string; }

interface KeyFile { publicKeyDerB64: string; privateKeyPkcs8B64: string; }

function pubToToken(derB64: string): string { return `ed25519:${derB64}`; }

export function loadOrCreateIdentity(dir = join(homedir(), ".agentgem")): Identity {
  const file = join(dir, "identity.json");
  let kf: KeyFile;
  if (existsSync(file)) {
    kf = JSON.parse(readFileSync(file, "utf8")) as KeyFile;
  } else {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    kf = {
      publicKeyDerB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      privateKeyPkcs8B64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(kf), { mode: 0o600 });
  }
  const priv = createPrivateKey({ key: Buffer.from(kf.privateKeyPkcs8B64, "base64"), format: "der", type: "pkcs8" });
  return {
    publicKey: pubToToken(kf.publicKeyDerB64),
    sign(data: string) { return edSign(null, Buffer.from(data, "utf8"), priv).toString("base64"); },
  };
}

export function verify(publicKey: string, data: string, signatureB64: string): boolean {
  if (!publicKey.startsWith("ed25519:")) return false;
  const der = Buffer.from(publicKey.slice("ed25519:".length), "base64");
  const pub = createPublicKey({ key: der, format: "der", type: "spki" });
  return edVerify(null, Buffer.from(data, "utf8"), pub, Buffer.from(signatureB64, "base64"));
}

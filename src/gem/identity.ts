// src/gem/identity.ts
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey } from "node:crypto";
import { mkdirSync, writeFileSync, lstatSync, chmodSync, openSync, readSync, fstatSync, fchmodSync, closeSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Identity { publicKey: string; sign(data: string): string; }

interface KeyFile { publicKeyDerB64: string; privateKeyPkcs8B64: string; }

function pubToToken(derB64: string): string { return `ed25519:${derB64}`; }

export function loadOrCreateIdentity(dir = join(homedir(), ".agentgem")): Identity {
  const file = join(dir, "identity.json");

  // Guard the directory: reject symlinks, tighten group/world bits if present.
  try {
    const ds = lstatSync(dir);
    if (ds.isSymbolicLink()) throw new Error("identity dir is a symlink; refusing");
    if (ds.mode & 0o077) chmodSync(dir, 0o700);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // dir doesn't exist yet — mkdirSync will create it
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Open the key file with O_NOFOLLOW so the open fails atomically (ELOOP) if the
  // final path component is a symlink, closing the lstat→open TOCTOU window.
  const readViaFd = (): KeyFile => {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (st.mode & 0o077) fchmodSync(fd, 0o600);
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      return JSON.parse(buf.toString("utf8")) as KeyFile;
    } finally {
      closeSync(fd);
    }
  };

  let kf: KeyFile;
  try {
    kf = readViaFd();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw e; // ELOOP (symlink) or other error → propagate
    // File absent — generate a new keypair.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    kf = {
      publicKeyDerB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      privateKeyPkcs8B64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    };
    try {
      writeFileSync(file, JSON.stringify(kf), { mode: 0o600, flag: "wx" });
    } catch (we) {
      if ((we as NodeJS.ErrnoException).code !== "EEXIST") throw we;
      // Race: another process created the file first; read it atomically.
      kf = readViaFd();
    }
  }

  const priv = createPrivateKey({ key: Buffer.from(kf.privateKeyPkcs8B64, "base64"), format: "der", type: "pkcs8" });
  return {
    publicKey: pubToToken(kf.publicKeyDerB64),
    sign(data: string) { return edSign(null, Buffer.from(data, "utf8"), priv).toString("base64"); },
  };
}

export function verify(publicKey: string, data: string, signatureB64: string): boolean {
  if (!publicKey.startsWith("ed25519:")) return false;
  try {
    const der = Buffer.from(publicKey.slice("ed25519:".length), "base64");
    const pub = createPublicKey({ key: der, format: "der", type: "spki" });
    return edVerify(null, Buffer.from(data, "utf8"), pub, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

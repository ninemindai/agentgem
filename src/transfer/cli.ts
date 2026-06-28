// src/transfer/cli.ts
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { sendGemBytes, receiveGem } from "./index.js";
import type { ObjectStore } from "./objectStore.js";
import { NatsObjectStore } from "./natsObjectStore.js";
import { loadOrCreateIdentity } from "../gem/identity.js";

export interface CliIO {
  readFile: (p: string) => Promise<Buffer>;
  writeFile: (p: string, b: Buffer) => Promise<void>;
  log: (s: string) => void;
  err: (s: string) => void;
}

const defaultIO: CliIO = {
  readFile: (p) => fsReadFile(p),
  writeFile: (p, b) => fsWriteFile(p, b),
  log: (s) => console.log(s),
  err: (s) => console.error(s),
};

// bucket arg only matters to NATS; the in-memory store ignores it.
export async function runCli(argv: string[], store: ObjectStore, io: CliIO = defaultIO): Promise<number> {
  const [cmd, ...rest] = argv;
  const bucket = (store as { bucket?: string }).bucket ?? "agentgem-transfer";
  if (cmd === "send") {
    if (!rest[0]) { io.err("usage: send <file.gem>"); return 2; }
    try {
      const bytes = await io.readFile(rest[0]);
      // The CLI signs with the local identity so the recipient sees who sent it.
      const { ticket } = await sendGemBytes(bytes, store, bucket, { identity: loadOrCreateIdentity() });
      io.log(ticket);
      return 0;
    } catch (e) {
      io.err(e instanceof Error ? e.message : String(e));
      return 1;
    }
  }
  if (cmd === "receive") {
    if (!rest[0]) { io.err("usage: receive <ticket> [out.gem]"); return 2; }
    try {
      const { gem, meta, bytes, provenance } = await receiveGem(rest[0], store);
      const outPath = rest[1] ?? `${gem.name}.gem`;
      await io.writeFile(outPath, bytes);
      const origin = provenance.signed
        ? (provenance.verified ? `✓ from ${provenance.publicKey!.slice(0, 12)}…` : "⚠ unverified origin (signature did not verify)")
        : "(unsigned)";
      io.err(`✓ verified integrity · ${meta.name}@${meta.version} · ${origin} → ${outPath}`);
      return 0;
    } catch (e) {
      io.err(e instanceof Error ? e.message : String(e));
      return 1;
    }
  }
  io.err("usage: agentgem send <file.gem> | agentgem receive <ticket> [out.gem]");
  return 2;
}

// bin shim: wire a NATS store from env. NATS_URL defaults to local dev broker.
export async function main(argv: string[]): Promise<void> {
  // Report usage errors before opening a connection, so `agentgem send` (no file)
  // prints usage instead of failing on the broker.
  const [cmd, arg] = argv;
  if ((cmd === "send" || cmd === "receive") && !arg) {
    console.error(cmd === "send" ? "usage: agentgem send <file.gem>" : "usage: agentgem receive <ticket> [out.gem]");
    process.exitCode = 2;
    return;
  }
  const servers = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
  const store = await NatsObjectStore.connect({ servers, token: process.env.NATS_TOKEN });
  try {
    process.exitCode = await runCli(argv, store);
  } finally {
    await store.close();
  }
}

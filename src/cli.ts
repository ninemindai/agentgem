#!/usr/bin/env node
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/cli.ts — the `agentgem` command. A thin wrapper over run() in index.ts:
// parses a couple of flags and starts the local server. Published as the `bin`
// entry so `npx @ninemind/agentgem` and a global install both work.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run } from "./index.js";

function version(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const HELP = `agentgem — build secret-safe, composable Gems from your coding-agent config

Usage:
  agentgem [options]

Options:
  -p, --port <n>   Port to listen on (default: 4317, or $PORT)
  -v, --version    Print version and exit
  -h, --help       Show this help

Once running, open the printed URL (default http://127.0.0.1:4317/). Append
?dir=/path/to/.claude to introspect a config directory other than ~/.claude.

Sharing a Gem (store-and-forward over NATS; set $NATS_URL, default nats://127.0.0.1:4222):
  agentgem send <file.gem>              Encrypt + stash; prints a one-time agentgem:// ticket
  agentgem receive <ticket> [out.gem]   Fetch, decrypt, verify; writes the .gem
  agentgem bind                         Bind this machine's key to your GitHub account`;

async function main(argv: string[]): Promise<void> {
  const has = (...names: string[]) => names.some((n) => argv.includes(n));
  const opt = (...names: string[]) => {
    for (const n of names) {
      const i = argv.indexOf(n);
      if (i >= 0) return argv[i + 1];
    }
    return undefined;
  };

  if (has("-h", "--help")) return void console.log(HELP);
  if (has("-v", "--version")) return void console.log(version());

  // `agentgem send|receive ...` — the store-and-forward Gem transfer subcommands.
  // Delegated to the transfer CLI, which wires a NATS store from $NATS_URL.
  if (argv[0] === "send" || argv[0] === "receive") {
    const { main: transferMain } = await import("@agentgem/transfer");
    return transferMain(argv);
  }

  // `agentgem bind` — bind this machine's signing key to a GitHub account (anti-sybil identity).
  if (argv[0] === "bind") {
    const { main: bindMain } = await import("./bind/cli.js");
    return bindMain(argv);
  }

  const portArg = opt("-p", "--port");
  const port = Number(portArg ?? process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`agentgem: invalid port "${portArg}"`);
    process.exit(1);
  }

  await run(port);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});

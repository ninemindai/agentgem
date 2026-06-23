#!/usr/bin/env node
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
?dir=/path/to/.claude to introspect a config directory other than ~/.claude.`;

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

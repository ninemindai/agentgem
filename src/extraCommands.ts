// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The CLI extension seam. OSS ships an empty table; a downstream build can register
// additional `agentgem <cmd>` subcommands (e.g. commands a later phase moves out of
// the built-in set) without editing cli.ts. dispatchExtra returns null when a command
// is unhandled so the caller falls through to the default start-the-server path.
export type ExtraCommand = (argv: string[]) => Promise<number | void>;

export const extraCommands: Record<string, ExtraCommand> = {};

export async function dispatchExtra(
  argv: string[],
  table: Record<string, ExtraCommand> = extraCommands,
): Promise<number | null> {
  const name = argv[0];
  if (!name || !Object.hasOwn(table, name)) return null;
  const code = await table[name](argv.slice(1));
  return typeof code === "number" ? code : 0;
}

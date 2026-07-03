// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/service.ts
//
// OS-service install for the Trigger C daemon: pure unit generators + a
// platform-dispatched install/uninstall. macOS launchd, Linux systemd-user.
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@agentgem/base";

const warmLog = createLogger("warm");

export class UnsupportedPlatformError extends Error {}

const LABEL = "ai.ninemind.agentgem.warm";

export function launchdPlist(execArgs: string[], label: string = LABEL): string {
  const args = execArgs.map((a) => `    <string>${a}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

export function systemdUnit(execArgs: string[]): string {
  return `[Unit]
Description=AgentGem warming daemon

[Service]
ExecStart=${execArgs.join(" ")}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

interface ServiceDeps {
  platform?: NodeJS.Platform; home?: string; exec?: string[];
  writeFile?: (p: string, c: string) => void;
  unlink?: (p: string) => void;
  mkdir?: (p: string) => void;
}

function defaultExec(): string[] {
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  return [process.execPath, cliPath, "warm", "--watch"];
}

function target(platform: NodeJS.Platform, home: string): { path: string; render: (exec: string[]) => string; loadCmd: string } {
  if (platform === "darwin") {
    return {
      path: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
      render: (e) => launchdPlist(e),
      loadCmd: `launchctl load ${join(home, "Library", "LaunchAgents", `${LABEL}.plist`)}`,
    };
  }
  if (platform === "linux") {
    const p = join(home, ".config", "systemd", "user", "agentgem-warm.service");
    return { path: p, render: (e) => systemdUnit(e), loadCmd: "systemctl --user enable --now agentgem-warm.service" };
  }
  throw new UnsupportedPlatformError(`agentgem warm --install-service: unsupported platform '${platform}' (macOS and Linux only)`);
}

export function installService(deps: ServiceDeps = {}): { path: string; loadCmd: string } {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const exec = deps.exec ?? defaultExec();
  const writeFile = deps.writeFile ?? ((p, c) => writeFileSync(p, c, "utf8"));
  const mkdir = deps.mkdir ?? ((p) => { mkdirSync(p, { recursive: true }); });
  const t = target(platform, home);
  mkdir(dirname(t.path));
  writeFile(t.path, t.render(exec));
  return { path: t.path, loadCmd: t.loadCmd };
}

export function uninstallService(deps: ServiceDeps = {}): { path: string; removed: boolean } {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const unlink = deps.unlink ?? ((p) => unlinkSync(p));
  const t = target(platform, home);
  try { unlink(t.path); return { path: t.path, removed: true }; }
  catch { return { path: t.path, removed: false }; }
}

interface RunServiceDeps {
  install?: (d?: ServiceDeps) => { path: string; loadCmd: string };
  uninstall?: (d?: ServiceDeps) => { path: string; removed: boolean };
  log?: (m: string) => void;
  errorLog?: (m: string) => void;
  exit?: (code: number) => void;
}

export function runServiceCommand(argv: string[], deps: RunServiceDeps = {}): void {
  const install = deps.install ?? installService;
  const uninstall = deps.uninstall ?? uninstallService;
  const log = deps.log ?? ((m: string) => warmLog.info("%s", m));
  const errorLog = deps.errorLog ?? ((m: string) => warmLog.error("%s", m));
  const exit = deps.exit ?? ((c) => process.exit(c));
  try {
    if (argv.includes("--uninstall-service")) {
      const r = uninstall();
      log(r.removed ? `agentgem warm: removed service unit ${r.path}` : `agentgem warm: no service unit at ${r.path}`);
      return;
    }
    const r = install();
    log(`agentgem warm: wrote service unit ${r.path}`);
    log(`Enable it with:\n  ${r.loadCmd}`);
  } catch (err) {
    errorLog((err as Error).message);
    exit(1);
  }
}

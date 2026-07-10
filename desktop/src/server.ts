import { coreEntryCandidates, resolveCoreEntry } from "./core.js";

export interface EmbeddedServer {
  url: string;
  stop: () => Promise<void>;
}

/**
 * The slice of Electron's UtilityProcess this module uses. node's ChildProcess
 * satisfies it too, which is what lets the tests drive the real handshake on plain
 * node without an Electron runtime.
 */
export interface CoreChild {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  /** UtilityProcess.kill() takes no signal, so this is the force path only. */
  kill(): unknown;
}

export type ForkCore = (entry: string, env: NodeJS.ProcessEnv) => CoreChild;

export interface StartOptions {
  fork: ForkCore;
  /** The core exited on its own — a crash, not a stop() we asked for. */
  onCrash?: (code: number | null) => void;
  /** Injected so tests never fire SIGTERM at a real pid. */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  startTimeoutMs?: number;
  drainTimeoutMs?: number;
}

/** run() in src/index.ts emits this as one json line on stdout when AGENTGEM_IPC=1. */
export function parseReadyUrl(line: string): string | null {
  if (!line.startsWith("{")) return null; // the core's human log lines are the common case
  try {
    const msg = JSON.parse(line) as { type?: unknown; url?: unknown };
    return msg.type === "ready" && typeof msg.url === "string" ? msg.url : null;
  } catch {
    return null;
  }
}

/** Reassemble lines: a ready line can arrive split across two stdout chunks. */
function onEachLine(stream: NodeJS.ReadableStream | null, fn: (line: string) => void): void {
  let buf = "";
  stream?.on("data", (chunk: Buffer | string) => {
    buf += String(chunk);
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      fn(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  });
}

/**
 * Run the core as a child process and wait for it to report the port it bound.
 *
 * The core used to be import()ed into Electron's main process, which put the REST
 * server on the same event loop as the tray, the menu and ipcMain: anything slow in
 * the core froze the window *and* stalled every request the renderer made, because
 * the server was main. Out of process, main only holds the handle.
 */
export async function startEmbeddedServer(
  mainDir: string,
  resourcesPath: string,
  opts: StartOptions,
): Promise<EmbeddedServer> {
  const {
    fork,
    onCrash,
    signal = (pid, sig) => void process.kill(pid, sig),
    startTimeoutMs = 30_000,
    drainTimeoutMs = 5_000,
  } = opts;

  const entry = resolveCoreEntry(coreEntryCandidates(mainDir, resourcesPath));
  // PORT=0 lets the OS assign a free port and the child report it back, which closes
  // the bind/close/re-bind race the old getFreePort() had to tolerate.
  const child = fork(entry, { ...process.env, PORT: "0", AGENTGEM_IPC: "1" });

  let ready = false;
  let stopping = false;
  child.on("exit", (code) => {
    if (ready && !stopping) onCrash?.(code);
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`core did not report a ready url within ${startTimeoutMs}ms`)),
      startTimeoutMs,
    );
    const settle =
      <T>(fn: (value: T) => void) =>
      (value: T) => {
        clearTimeout(timer);
        fn(value);
      };
    const done = settle(resolve);
    const fail = settle(reject);

    onEachLine(child.stdout, (line) => {
      const found = parseReadyUrl(line);
      if (found) done(found);
    });
    // The core logs to stderr; fold it into the host's own output rather than drop it.
    onEachLine(child.stderr, (line) => {
      if (line) console.error(`[core] ${line}`);
    });
    child.on("exit", (code) => fail(new Error(`core exited (${code}) before it was ready`)));
  });

  ready = true;
  return {
    url,
    stop: () => {
      stopping = true;
      return drain(child, signal, drainTimeoutMs);
    },
  };
}

/**
 * installGracefulShutdown() in src/index.ts already drains the core on SIGTERM, so
 * signal it and give it a moment; kill() is only the backstop for a core that hangs.
 */
function drain(
  child: CoreChild,
  signal: (pid: number, sig: NodeJS.Signals) => void,
  timeoutMs: number,
): Promise<void> {
  const { pid } = child;
  if (pid === undefined) {
    child.kill();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      child.kill();
      resolve();
    }, timeoutMs);
    child.on("exit", () => {
      clearTimeout(force);
      resolve();
    });
    try {
      signal(pid, "SIGTERM");
    } catch {
      clearTimeout(force); // already gone
      resolve();
    }
  });
}

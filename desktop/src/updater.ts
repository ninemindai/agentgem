export interface GithubFeed {
  provider: "github";
  owner: string;
  repo: string;
}

export function updaterFeed(repoUrl: string): GithubFeed {
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`Cannot parse a GitHub repo from: ${repoUrl}`);
  return { provider: "github", owner: m[1], repo: m[2] };
}

// Pull the repo URL out of a package.json `repository` field, which may be a
// bare string ("owner/repo" or a full URL) or the object form { url }.
export function repoUrlFromPackageJson(pkg: {
  repository?: string | { url?: string };
}): string {
  const repo = pkg.repository;
  const url = typeof repo === "string" ? repo : repo?.url;
  if (!url) throw new Error("package.json has no repository url");
  return url;
}

interface MinimalUpdater {
  autoDownload: boolean;
  on(event: string, cb: (...args: any[]) => void): void;
  checkForUpdates(): Promise<unknown>;
}

// What the controller asks the host (main process) to show. Kept as an interface so the
// branching logic below stays pure and testable — the actual native dialogs live in main.ts.
export interface UpdateSurface {
  upToDate(version: string): void;
  downloading(version: string): void;
  ready(version: string): void;
  failed(err: Error): void;
}

export interface UpdateController {
  // manual: true when the user picked "Check for Updates…"; false for the startup check.
  check(opts?: { manual?: boolean }): void;
}

// Wiring around electron-updater. autoUpdater is a singleton emitter shared by the startup
// check and the menu action, so a `manual` flag scopes the noisy dialogs (up-to-date /
// downloading / error) to explicit user action. A finished download prompts to restart either
// way — a ready update should surface no matter how the check was triggered.
export function createUpdateController(updater: MinimalUpdater, surface: UpdateSurface): UpdateController {
  updater.autoDownload = true;
  let manual = false;
  let inFlight = false;
  const done = (): void => {
    manual = false;
    inFlight = false;
  };

  updater.on("update-available", (info: { version?: string }) => {
    if (manual) surface.downloading(info?.version ?? "");
    // Stays in flight: autoDownload is on, so "update-downloaded" follows.
  });
  updater.on("update-not-available", (info: { version?: string }) => {
    if (manual) surface.upToDate(info?.version ?? "");
    done();
  });
  updater.on("update-downloaded", (info: { version?: string }) => {
    surface.ready(info?.version ?? "");
    done();
  });
  // A failed check emits "error" AND rejects the promise. Without a listener the emit throws
  // (EventEmitter's unhandled-"error" rule) — which is how a 404 on the release's latest*.yml
  // stayed invisible for two releases. A background failure stays in the log; the app works
  // fine without an update.
  updater.on("error", (err: Error) => {
    if (manual) surface.failed(err);
    else console.error("[updater] check failed:", err?.message ?? err);
    done();
  });

  return {
    check({ manual: isManual = false } = {}) {
      if (inFlight) return; // one check at a time — ignore a double-click or an overlapping startup check
      manual = isManual;
      inFlight = true;
      // The "error" listener above surfaces the failure; this only keeps the rejection from
      // going unhandled in the main process.
      void updater.checkForUpdates().catch(() => {});
    },
  };
}

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
  checkForUpdatesAndNotify(): Promise<unknown>;
}

// Thin wiring around electron-updater; exercised via the manual smoke checklist
// (a real update requires a published, signed release).
export function configureUpdater(
  updater: MinimalUpdater,
  handlers: { onAvailable: () => void; onDownloaded: () => void },
): void {
  updater.autoDownload = true;
  updater.on("update-available", handlers.onAvailable);
  updater.on("update-downloaded", handlers.onDownloaded);
  void updater.checkForUpdatesAndNotify();
}

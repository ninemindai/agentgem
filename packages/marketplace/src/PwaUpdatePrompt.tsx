import { useRegisterSW } from "virtual:pwa-register/react";

// A small non-intrusive banner shown after a new deploy. registerType:"prompt" means the new
// service worker waits; clicking Reload calls updateServiceWorker(true), which activates it and
// reloads the page. We never auto-reload — that could interrupt a game mid-play.
export function PwaUpdatePrompt() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <div className="ex-pwa-update" role="status">
      <span>New version available</span>
      <button type="button" onClick={() => updateServiceWorker(true)}>Reload</button>
    </div>
  );
}

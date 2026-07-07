export interface AgentGemBridge {
  notify?: (title: string, body: string) => void;
}

// Single call site for OS notifications. In Electron the preload bridge is
// present and needs no permission; in a plain browser we fall back to the
// Notification API (only fires once the user has granted permission).
export function osNotify(title: string, body: string): void {
  const bridge = (window as unknown as { agentgem?: AgentGemBridge }).agentgem;
  if (bridge?.notify) {
    bridge.notify(title, body);
    return;
  }
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

// packages/console/src/panels/Play/studioChatStore.ts
// Per-miniapp durable pointer to its ACP session, so a Studio chat survives panel
// navigation and full reloads. Mirrors consent.ts's try/localStorage/catch idiom.
// Plain get/set/clear — no store/hook (see Review note C1); Studio reads it once
// on mount via loadStudioSession, then drives its own React state.

export type StudioChat = { chatId: string; sessionId: string; agent: string };

const key = (name: string) => `agentgem:play:studiochat:${name}`;

export function getStudioChat(name: string): StudioChat | null {
  try {
    const raw = localStorage.getItem(key(name));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StudioChat>;
    if (typeof v?.sessionId !== "string" || typeof v?.agent !== "string") return null;
    return { chatId: typeof v.chatId === "string" ? v.chatId : "", sessionId: v.sessionId, agent: v.agent };
  } catch { return null; }
}

export function setStudioChat(name: string, v: StudioChat): void {
  try { localStorage.setItem(key(name), JSON.stringify(v)); } catch { /* private mode */ }
}

export function clearChatId(name: string): void {
  const cur = getStudioChat(name);
  if (cur) setStudioChat(name, { ...cur, chatId: "" });
}

export function clearStudioChat(name: string): void {
  try { localStorage.removeItem(key(name)); } catch { /* private mode */ }
}

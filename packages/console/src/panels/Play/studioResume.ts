// packages/console/src/panels/Play/studioResume.ts
// Restore a Studio chat from its durable on-disk transcript (via /api/inspect/session).
import type { TranscriptTurn } from "../../api/routes.js";
import { makeClient, inspectSessionRoute } from "../../api/routes.js";
import { getStudioChat, clearChatId } from "./studioChatStore.js";

export type StudioMsg =
  | { role: "user" | "agent"; text: string }
  | { role: "tool"; title: string; failed?: boolean };

// The first turn's prompt is `${brief}\n\n---\nUser: ${message}` (chatSession.ts). Strip
// everything up to and including the first marker so the user sees their message, not the brief.
const BRIEF_MARK = "\n---\nUser: ";
function stripBrief(text: string): string {
  const i = text.indexOf(BRIEF_MARK);
  return i === -1 ? text : text.slice(i + BRIEF_MARK.length);
}

export function transcriptToMsgs(turns: TranscriptTurn[]): StudioMsg[] {
  const out: StudioMsg[] = [];
  let firstUserSeen = false;
  for (const t of turns) {
    for (const s of t.spans) {
      if (s.kind === "message") {
        if (s.role === "user") {
          const text = !firstUserSeen ? stripBrief(s.text) : s.text;
          firstUserSeen = true;
          out.push({ role: "user", text });
        } else {
          out.push({ role: "agent", text: s.text });
        }
      } else {
        out.push({ role: "tool", title: s.name, failed: s.error === true });
      }
    }
  }
  return out;
}

export type StudioResume = { msgs: StudioMsg[]; chatId: string | null; sessionId: string | null; running: boolean };

// Transcript-only read, reused by loadStudioSession and by Studio's resume poll (so a
// running turn's completed spans surface as it works). No session pointer → [], no round-trip.
// A 404 (opened-but-no-output, or file gone) or any read failure → [], never throws.
export async function loadStudioTranscript(apiBase: string, name: string): Promise<StudioMsg[]> {
  const stored = getStudioChat(name);
  if (!stored) return [];
  try {
    const view = await inspectSessionRoute.call(makeClient(apiBase), {
      query: { id: stored.sessionId, agent: stored.agent as "claude" | "codex" },
    });
    return transcriptToMsgs(view.turns);
  } catch { return []; }
}

export async function loadStudioSession(apiBase: string, name: string): Promise<StudioResume> {
  const stored = getStudioChat(name);
  if (!stored) return { msgs: [], chatId: null, sessionId: null, running: false };

  // History from the durable transcript. 404 / read failure → empty, not an error.
  const msgs = await loadStudioTranscript(apiBase, name);

  // Liveness — only the in-memory ChatManager knows. No chatId stored → treat as dead.
  let alive = false, running = false;
  if (stored.chatId) {
    try {
      const res = await fetch(`${apiBase}/api/chat/${encodeURIComponent(stored.chatId)}/state`);
      const st = res.ok ? await res.json() as { alive: boolean; running?: boolean } : { alive: false };
      alive = st.alive === true;
      running = alive && st.running === true;
    } catch { alive = false; }
  }

  if (!alive && stored.chatId) clearChatId(name); // fresh-continue on next send; keep sessionId for history
  return { msgs, chatId: alive ? stored.chatId : null, sessionId: stored.sessionId, running };
}

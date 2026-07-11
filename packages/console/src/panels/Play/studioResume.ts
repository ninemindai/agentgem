// packages/console/src/panels/Play/studioResume.ts
// Restore a Studio chat from its durable on-disk transcript (via /api/inspect/session).
import type { TranscriptTurn } from "../../api/routes.js";

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

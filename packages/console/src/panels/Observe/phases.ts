import type { TranscriptView, TranscriptTurn } from "../../api/routes.js";

export interface Phase { label: string; turns: number; out: number; tools: string[]; skills: number; agents: number }

function firstUserText(turn: TranscriptTurn): string | null {
  const m = turn.spans.find((s) => s.kind === "message" && s.role === "user");
  return m && m.kind === "message" ? m.text.split("\n", 1)[0].slice(0, 120) : null;
}

export function phasesOf(view: TranscriptView): Phase[] {
  const phases: Phase[] = [];
  let cur: Phase | null = null;
  const ensure = (label: string) => { cur = { label, turns: 0, out: 0, tools: [], skills: 0, agents: 0 }; phases.push(cur); return cur; };

  for (const turn of view.turns) {
    const ut = turn.role === "user" ? firstUserText(turn) : null;
    if (ut !== null) { ensure(ut); continue; }
    if (!cur) cur = ensure("(session start)");
    cur.turns += 1;
    cur.out += turn.tokens.out;
    for (const s of turn.spans) {
      if (s.kind !== "tool_call") continue;
      cur.tools.push(s.name);
      if (s.name === "Skill") cur.skills += 1;
      if (s.name === "Task" || s.name === "Agent") cur.agents += 1;
    }
  }
  return phases.filter((p) => p.turns > 0);
}

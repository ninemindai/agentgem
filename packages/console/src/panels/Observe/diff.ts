// packages/console/src/panels/Observe/diff.ts
//
// Pure client-side turn alignment for the side-by-side transcript diff (phase 4).
// Resolves the proposal's open question — "turn-by-turn is naive when two runs
// diverge early" — with an LCS alignment over coarse turn *signatures* (role +
// tool-name sequence + first message line). LCS keeps matched turns aligned and
// surfaces inserts/deletes around a divergence, instead of a positional zip that
// smears every turn after the first difference. Within an aligned pair, full
// content decides same-vs-changed.
import type { TranscriptTurn } from "../../api/routes.js";

export type DiffStatus = "same" | "changed" | "added" | "removed";
export interface DiffRow { a: TranscriptTurn | null; b: TranscriptTurn | null; status: DiffStatus; }

/** Coarse alignment key: stable under small content drift so a tweaked turn
 *  aligns as "changed" rather than a remove+add pair. */
export function turnSignature(t: TranscriptTurn): string {
  const tools = t.spans.flatMap((s) => (s.kind === "tool_call" ? [s.name] : [])).join(",");
  const msg = t.spans.find((s) => s.kind === "message");
  const head = msg && msg.kind === "message" ? msg.text.split("\n", 1)[0].slice(0, 40) : "";
  return `${t.role}|${tools}|${head}`;
}

function contentKey(t: TranscriptTurn): string {
  return JSON.stringify(t.spans);
}

export function alignTurns(a: TranscriptTurn[], b: TranscriptTurn[]): DiffRow[] {
  const n = a.length, m = b.length;
  const sigA = a.map(turnSignature), sigB = b.map(turnSignature);
  // LCS length table over signatures (suffix DP).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = sigA[i] === sigB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const rows: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (sigA[i] === sigB[j]) {
      rows.push({ a: a[i], b: b[j], status: contentKey(a[i]) === contentKey(b[j]) ? "same" : "changed" });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ a: a[i], b: null, status: "removed" }); i++;
    } else {
      rows.push({ a: null, b: b[j], status: "added" }); j++;
    }
  }
  while (i < n) rows.push({ a: a[i++], b: null, status: "removed" });
  while (j < m) rows.push({ a: null, b: b[j++], status: "added" });
  return rows;
}

export function diffCounts(rows: DiffRow[]): Record<DiffStatus, number> {
  const c: Record<DiffStatus, number> = { same: 0, changed: 0, added: 0, removed: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

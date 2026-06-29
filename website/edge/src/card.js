// Canonical goldmine certificate card. Pure: counts -> 1200x630 SVG string.
// Content/styling mirror packages/console/src/panels/Mine/trophy.ts:trophyLines.
// Counts only — never project/workflow names (privacy boundary).

const W = 1200, H = 630;
const BG = "#0b0f17", ACCENT = "#7cc4ff", INK = "#e8edf5", MUTED = "#6b7689";

const n = (v) => String(Math.max(0, Math.trunc(Number(v) || 0)));

/** @param {{breadth:number,battleTested:number,portable:number}} c */
export function renderCardSvg(c) {
  const counts = [
    { t: `${n(c.breadth)} reusable workflows`, fill: ACCENT },
    { t: `${n(c.battleTested)} battle-tested`, fill: INK },
    { t: `${n(c.portable)} worth sharing`, fill: INK },
  ];
  const lines = counts
    .map((l, i) => `<text x="80" y="${300 + i * 96}" fill="${l.fill}" font-size="64" font-weight="700">${l.t}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>` +
    `<text x="80" y="140" fill="${INK}" font-size="48" font-weight="600">My Agent Goldmine</text>` +
    lines +
    `<text x="80" y="${H - 56}" fill="${MUTED}" font-size="28">Valued with AgentGem</text>` +
    `<text x="${W - 260}" y="${H - 56}" fill="${ACCENT}" font-size="28" font-weight="700">AgentGem</text>` +
    `</svg>`;
}

/** @param {{breadth:number,battleTested:number,portable:number}} c */
export function cardDescription(c) {
  return `${n(c.breadth)} reusable workflows · ${n(c.battleTested)} battle-tested · ${n(c.portable)} worth sharing — valued with AgentGem`;
}

// Pure branded card: (type, title, subtitle) -> 1200x630 SVG string. One shared frame + a per-type
// accent/label. Sibling of website/edge/src/card.js's certificate template (kept separate; different
// content). Text is escaped and length-capped before it reaches the SVG.
import type { CardType } from "./resolve.js";

const W = 1200, H = 630;
const BG = "#0b0f17", INK = "#e8edf5", MUTED = "#6b7689";
const ACCENT: Record<CardType, string> = { game: "#7cc4ff", gem: "#c4b5fd", profile: "#86efac", skill: "#fbbf24" };
const LABEL: Record<CardType, string> = { game: "Miniapp", gem: "Gem", profile: "Profile", skill: "Skill" };

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function frame(accent: string, label: string, title: string, subtitle: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>` +
    `<text x="80" y="130" fill="${accent}" font-size="34" font-weight="700" letter-spacing="4">${esc(label)}</text>` +
    `<text x="80" y="300" fill="${INK}" font-size="76" font-weight="700">${esc(cap(title, 80))}</text>` +
    `<text x="80" y="380" fill="${MUTED}" font-size="40">${esc(cap(subtitle, 120))}</text>` +
    `<text x="80" y="${H - 56}" fill="${MUTED}" font-size="28">agentgem.ai</text>` +
    `<text x="${W - 260}" y="${H - 56}" fill="${accent}" font-size="28" font-weight="700">AgentGem</text>` +
    `</svg>`
  );
}

export function renderCardSvg(o: { type: CardType; title: string; subtitle: string }): string {
  return frame(ACCENT[o.type], LABEL[o.type], o.title, o.subtitle);
}

export function placeholderSvg(): string {
  return frame("#7cc4ff", "AgentGem", "Discover agent gems", "Miniapps, skills & more on AgentGem");
}

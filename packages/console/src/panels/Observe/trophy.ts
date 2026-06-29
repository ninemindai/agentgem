// Aggregate-only, local, opt-in trophy. trophyLines() is the single source of
// what text appears on the card — counts only, so project/workflow names can
// never leak into a shared image ("share the trophy, not the goldmine").
import type { Scorecard } from "../../api/routes.js";

const W = 1200, H = 630;   // OG-image proportions

export function trophyLines(sc: Scorecard): { title: string; counts: string[]; tagline: string } {
  return {
    title: "My Agent Goldmine",
    counts: [
      `${sc.breadth} reusable workflows`,
      `${sc.battleTested} battle-tested`,
      `${sc.portable} worth sharing`,
    ],
    tagline: "Valued with AgentGem",
  };
}

export function drawTrophy(canvas: HTMLCanvasElement, sc: Scorecard): void {
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { title, counts, tagline } = trophyLines(sc);
  ctx.fillStyle = "#0b0f17"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#e8edf5"; ctx.textBaseline = "top";
  ctx.font = "600 48px system-ui, sans-serif"; ctx.fillText(title, 80, 80);
  ctx.font = "700 64px system-ui, sans-serif";
  counts.forEach((line, i) => { ctx.fillStyle = i === 0 ? "#7cc4ff" : "#e8edf5"; ctx.fillText(line, 80, 200 + i * 96); });
  ctx.fillStyle = "#6b7689"; ctx.font = "400 28px system-ui, sans-serif"; ctx.fillText(tagline, 80, H - 80);
  ctx.fillStyle = "#7cc4ff"; ctx.font = "700 28px system-ui, sans-serif"; ctx.fillText("AgentGem", W - 260, H - 80);
}

export async function shareTrophy(canvas: HTMLCanvasElement): Promise<void> {
  const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
  if (!blob) return;
  const file = new File([blob], "agentgem-goldmine.png", { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], title: "My Agent Goldmine" });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "agentgem-goldmine.png"; a.click();
  URL.revokeObjectURL(url);
}

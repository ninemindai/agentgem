// Per-workflow and per-gem share cards. workflowCardLines / gemCardLines are the
// single source of what text appears on the canvas — description is already
// sanitised server-side; steps come from the WorkflowDetail the server returned.
// The share function is extracted here so both workflow and gem cards share the
// same download / navigator.share path.
import type { WorkflowDetail } from "../../api/routes.js";

const W = 1200, H = 630; // OG-image proportions

const PAPER       = "#faf6f1"; // warm off-white
const TERRACOTTA  = "#c1440e"; // accent
const INK         = "#1a1208";
const INK_SOFT    = "#5c4a3a";
const MUTED       = "#9a8070";

// ── Canvas helpers ────────────────────────────────────────────────────────────

/** Truncate `text` with an ellipsis so it fits within `maxWidth` canvas pixels.
 * Returns text unchanged when measureText gives 0 (jsdom / uninitialized context). */
function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (!maxWidth || ctx.measureText(text).width === 0 || ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

// ── Workflow card ────────────────────────────────────────────────────────────

export function workflowCardLines(d: WorkflowDetail): {
  title: string;
  steps: string[];
  meta: string;
  invite: string;
} {
  return {
    title: d.name,
    steps: d.steps.slice(0, 5),
    meta: [
      `${d.sessions} session${d.sessions === 1 ? "" : "s"}`,
      `${d.confidence} confidence`,
      ...(d.portable ? ["portable"] : []),
      ...(d.tools.length ? [d.tools.slice(0, 4).join(", ")] : []),
    ].join(" · "),
    invite: "Valued with AgentGem",
  };
}

export function drawWorkflowCard(canvas: HTMLCanvasElement, d: WorkflowDetail): void {
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { title, steps, meta, invite } = workflowCardLines(d);

  // Paper background
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  // Terracotta accent bar
  ctx.fillStyle = TERRACOTTA; ctx.fillRect(0, 0, 8, H);

  // Title
  ctx.fillStyle = INK; ctx.textBaseline = "top";
  ctx.font = "700 52px system-ui, sans-serif";
  ctx.fillText(fit(ctx, title, W - 160), 80, 80);

  // Steps (up to 5)
  ctx.font = "400 30px system-ui, sans-serif";
  ctx.fillStyle = INK_SOFT;
  steps.forEach((step, i) => {
    ctx.fillText(fit(ctx, `${i + 1}. ${step}`, W - 160), 80, 180 + i * 56);
  });

  // Footer meta
  ctx.fillStyle = MUTED; ctx.font = "400 22px system-ui, sans-serif";
  ctx.fillText(meta, 80, H - 80);
  ctx.fillText(invite, 80, H - 48);

  // AgentGem wordmark
  ctx.fillStyle = TERRACOTTA; ctx.font = "700 28px system-ui, sans-serif";
  ctx.fillText("AgentGem", W - 260, H - 80);
}

// ── Gem card ─────────────────────────────────────────────────────────────────

export function gemCardLines(result: { name: string; skills: string[] }): {
  title: string;
  skillCount: string;
  skills: string;
  invite: string;
} {
  return {
    title: result.name,
    skillCount: `${result.skills.length} skill${result.skills.length === 1 ? "" : "s"}`,
    skills: result.skills.slice(0, 6).join(", "),
    invite: "Valued with AgentGem",
  };
}

export function drawGemCard(canvas: HTMLCanvasElement, result: { name: string; skills: string[] }): void {
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { title, skillCount, skills, invite } = gemCardLines(result);

  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = TERRACOTTA; ctx.fillRect(0, 0, 8, H);

  ctx.fillStyle = INK; ctx.textBaseline = "top";
  ctx.font = "700 52px system-ui, sans-serif";
  ctx.fillText(fit(ctx, title, W - 160), 80, 80);

  ctx.font = "700 80px system-ui, sans-serif";
  ctx.fillStyle = TERRACOTTA;
  ctx.fillText(skillCount, 80, 200);

  if (skills) {
    ctx.font = "400 32px system-ui, sans-serif";
    ctx.fillStyle = INK_SOFT;
    ctx.fillText(fit(ctx, skills, W - 160), 80, 320);
  }

  ctx.fillStyle = MUTED; ctx.font = "400 22px system-ui, sans-serif";
  ctx.fillText(invite, 80, H - 80);

  ctx.fillStyle = TERRACOTTA; ctx.font = "700 28px system-ui, sans-serif";
  ctx.fillText("AgentGem", W - 260, H - 80);
}

// ── Shared download / share ───────────────────────────────────────────────────

export async function shareCanvas(
  canvas: HTMLCanvasElement,
  filename: string,
  title: string,
): Promise<void> {
  const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
  if (!blob) return;
  const file = new File([blob], filename, { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], title });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

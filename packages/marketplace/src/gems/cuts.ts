// The gem "cut" vocabulary, mirrored from the server's GEM_TYPES for the marketplace
// (which can't import @agentgem/model). Each cut = a gemstone color rendered as a pill.
// Light-tinted bg + saturated label; Skill's emerald is kept distinct from the brand
// verified-green (#3a7d44) by tint + the pill styling.
export interface CutMeta { label: string; gemstone: string; bg: string; fg: string }

export const CUTS: Record<string, CutMeta> = {
  playbook: { label: "Playbook", gemstone: "Pearl", bg: "#ece9f5", fg: "#5b4b8a" },
  setup: { label: "Setup", gemstone: "Opal", bg: "#dbf1ec", fg: "#1f7a6a" },
  kit: { label: "Kit", gemstone: "Amethyst", bg: "#efe6f7", fg: "#8e44ad" },
  skill: { label: "Skill", gemstone: "Emerald", bg: "#d8f0e3", fg: "#1f7a52" },
  integration: { label: "Integration", gemstone: "Sapphire", bg: "#dde7f6", fg: "#2f5fa0" },
  guide: { label: "Guide", gemstone: "Topaz", bg: "#f7ecd0", fg: "#a9760a" },
};

/** Cut metadata, or null for an unknown/absent cut (→ render no badge, never mislabel). */
export function cutMeta(cut?: string): CutMeta | null {
  return cut ? CUTS[cut] ?? null : null;
}

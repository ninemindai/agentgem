// Per-platform share-intent URLs pointing at the hosted card. Pure.
export function shareIntents(url: string): { x: string; linkedin: string; facebook: string } {
  const u = encodeURIComponent(url);
  const text = encodeURIComponent("My agent goldmine, valued with AgentGem");
  return {
    x: `https://x.com/intent/tweet?url=${u}&text=${text}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
  };
}

// The star→stone curve, mirrored from the server-doc thresholds (0→1,1–2→2,3–7→3,
// 8–20→4,21+→5). The final stone count blends the authoring floor (grade, from the
// gem) with community stars: stones = min(5, max(floor, starCurve(stars))).
export function starCurve(stars: number): number {
  if (stars >= 21) return 5;
  if (stars >= 8) return 4;
  if (stars >= 3) return 3;
  if (stars >= 1) return 2;
  return 1;
}
export function stoneRating(floor: number | undefined, stars: number): number {
  return Math.min(5, Math.max(floor ?? 1, starCurve(stars)));
}

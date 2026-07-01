// The star→stone curve, mirrored from the server-doc thresholds (0→1,1–2→2,3–7→3,
// 8–20→4,21+→5). The final stone count blends the authoring floor (grade, from the
// gem) with community stars and adoption: stones = min(5, max(floor, starCurve(stars), adoptionCurve(installs))).
export function starCurve(stars: number): number {
  if (stars >= 21) return 5;
  if (stars >= 8) return 4;
  if (stars >= 3) return 3;
  if (stars >= 1) return 2;
  return 1;
}
// installs are k-anon (0 or >=5); <5 contributes nothing (returns 1 → ignored by max).
export function adoptionCurve(installs: number): number {
  if (installs >= 50) return 5;
  if (installs >= 10) return 4;
  if (installs >= 5) return 3;
  return 1;
}
export function stoneRating(floor: number | undefined, stars: number, installs = 0): number {
  return Math.min(5, Math.max(floor ?? 1, starCurve(stars), adoptionCurve(installs)));
}

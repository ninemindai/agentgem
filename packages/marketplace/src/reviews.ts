/** Reviews client. Credentialed so the parent-domain session cookie travels (reads work signed-out). */
import { NotSignedIn } from "./stars";

export interface ReviewSummary { avg: number; count: number }
export interface ReviewView { login: string; avatarUrl: string | null; rating: number; body: string | null; createdAt: string; updatedAt: string }
export interface MyReview { rating: number; body: string | null; createdAt: string; updatedAt: string }
export interface ReviewsData { summary: ReviewSummary; reviews: ReviewView[]; mine: MyReview | null }

export function makeReviews(base: string) {
  return {
    async getSummaries(kind: string, ids: string[]): Promise<Record<string, ReviewSummary>> {
      if (ids.length === 0) return {};
      const r = await fetch(base + "/api/reviews/summary?kind=" + encodeURIComponent(kind) + "&ids=" + encodeURIComponent(ids.join(",")));
      if (!r.ok) return {};
      return ((await r.json()) as { summaries?: Record<string, ReviewSummary> }).summaries ?? {};
    },
    async get(kind: string, id: string): Promise<ReviewsData> {
      const r = await fetch(base + "/api/reviews?kind=" + encodeURIComponent(kind) + "&id=" + encodeURIComponent(id), { credentials: "include" });
      if (!r.ok) throw new Error("reviews get -> " + r.status);
      return (await r.json()) as ReviewsData;
    },
    async submit(kind: string, id: string, rating: number, body: string | null): Promise<{ mine: MyReview; summary: ReviewSummary }> {
      const r = await fetch(base + "/api/reviews", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id, rating, body }),
      });
      if (r.status === 401) throw new NotSignedIn();
      if (!r.ok) throw new Error("reviews submit -> " + r.status);
      return (await r.json()) as { mine: MyReview; summary: ReviewSummary };
    },
    async remove(kind: string, id: string): Promise<{ summary: ReviewSummary }> {
      const r = await fetch(base + "/api/reviews?kind=" + encodeURIComponent(kind) + "&id=" + encodeURIComponent(id), { method: "DELETE", credentials: "include" });
      if (r.status === 401) throw new NotSignedIn();
      if (!r.ok) throw new Error("reviews remove -> " + r.status);
      return (await r.json()) as { summary: ReviewSummary };
    },
  };
}

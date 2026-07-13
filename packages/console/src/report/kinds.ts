// Shared report-kind metadata for the activity/notify surface. One place so adding a
// kind updates its display label AND its deep-link route together (they were
// previously duplicated across notify/events.ts and notify/ActivityMenu.tsx).
export const KIND_LABEL: Record<string, string> = { insights: "Insights", rubric: "Rubric", analyze: "Analysis" };
export const ROUTE_FOR: Record<string, string> = { insights: "#/insights", rubric: "#/rubrics", analyze: "#/curate" };

export interface RegistryGem {
  key: string;
  version: string;
  author?: string;
  description?: string;
  tags?: string[];
  artifactKinds?: string[];
  type?: string;
  publishedBy?: string;
  grade?: number;
  installable?: boolean;
  artifacts?: { name: string; type: string }[];
  createdAtMs?: number;
  updatedAtMs?: number;
}

export interface AggIngredient {
  id: string;
  kind: string;
  producers: number;
  verifiedProducers: number;
  invocations: number;
  sessions: number;
}
export interface AggCoOccurrence {
  id: string;
  producers: number;
  verifiedProducers: number;
}
export interface AggEffectiveness {
  gemName: string;
  mostly: number;
  partially: number;
  notAchieved: number;
  judged: number;
  producers: number;
  verifiedProducers: number;
  organic: number;
  confidence: number;
  score: number;
}
export interface AdoptionPoint {
  bucket: string;
  producers: number;
  verifiedProducers: number;
  invocations: number;
}

export interface ProfileGem {
  key: string;
  version: string;
  description: string | null;
  grade: number | null;
  stars: number;
  installs: number;
  verifiedInstalls: number;
}
export interface ProfileReview {
  sourceId: string;
  path: string;
  name: string;
  rating: number;
  body: string | null;
  createdAt: string;
}
export interface Profile {
  login: string;
  avatarUrl: string | null;
  verified: boolean;
  githubUrl: string | null;
  totalStars: number;
  gems: ProfileGem[];
  reviews: ProfileReview[];
}

export interface RubricCheck {
  id: string;
  label: string;
  pass: boolean;
  howToFix: string;
}
export interface OrgCatalogGem {
  key: string;
  version: string;
  cut: string | null;
  grade: number | null;
  owner: string;
  description: string | null;
  stars: number;
  installs: number;
  verifiedInstalls: number;
  rubric: { score: number; checks: RubricCheck[] };
}
export interface OrgCatalog {
  scope: string;
  gemCount: number;
  ownerCount: number;
  gems: OrgCatalogGem[];
}
export interface PopularSkill {
  sourceId: string;
  source: string;
  division: string;
  name: string;
  path: string;
  repo: string;
  homepage: string | null;
  stars: number;
  installs: number | null;
}
export interface PopularSkillItem {
  name: string;
  path: string;
  division: string;
  description: string | null;
  installs: number | null;
}
export interface PopularSkillGroup {
  sourceId: string;
  source: string;
  repo: string;
  homepage: string | null;
  stars: number;
  skills: PopularSkillItem[];
}
export interface CuratedSource {
  id: string; label: string; description: string;
  repo: string; ref: string; kind: string;
  license?: string; homepage?: string;
}
export interface SourceDivision { key: string; label: string; icon?: string; color?: string }
export interface SourceAgentRef { division: string; slug: string; name: string; path: string }
export interface ImportedSkill { name: string; description?: string; content: string; source?: string }

// Team usage dashboard (/orgs/:scope/usage) — mirrors the aggregator's OrgUsage payload.
export type OrgUsageRange = "7d" | "30d" | "all";
export interface OrgUsageMember {
  login: string; avatarUrl: string | null;
  sessions: number; msgs: number;
  tokensIn: number; tokensOut: number; tokensCache: number; tokens: number;
  activeMs: number; activeDays: number; lastActive: string | null;
}
export interface OrgUsageDay { date: string; sessions: number; tokens: number }
export interface OrgUsageModel { agent: string; model: string; sessions: number; tokens: number }
export interface OrgUsageAgent { agent: string; sessions: number; tokens: number }
export interface OrgUsage {
  scope: string; range: OrgUsageRange; memberCount: number;
  totals: { sessions: number; msgs: number; tokensIn: number; tokensOut: number; tokensCache: number; tokens: number; activeMs: number; activeDays: number };
  members: OrgUsageMember[];
  daily: OrgUsageDay[];
  models: OrgUsageModel[];
  agents: OrgUsageAgent[];
  facets: { agents: string[]; models: string[] };
  filtered: boolean; // agent/model filter active: only sessions+tokens are real, other metrics zeroed
}
// Org dashboard settings — admin-writable (GitHub org role captured at sign-in).
export interface OrgSettingsView { scope: string; retentionDays: number | null; dashboardEnabled: boolean; updatedBy: string | null; updatedAt: string | null; viewerRole: string }

// GitHub App install status + org-internal skills (gated on App install + membership).
export interface OrgAppStatus { installed: boolean; isMember: boolean; role: "self" | "admin" | "member" | null }
export interface OrgSkill { sourceId: string; path: string; division: string; name: string; repo: string; description: string | null }

// Org-scoped benchmark (/orgs/:scope/benchmark) — admin-only. Mirrors the aggregator's
// orgModelBenchmark/orgEffectiveness/orgMemberBreakdown payload (packages/aggregator/src/orgBenchmark.ts).
export interface OrgModelBenchmarkRow { model: string; mostly: number; partially: number; notAchieved: number; producers: number; successRate: number }
export interface OrgMemberBenchmarkRow { login: string; attestations: number; gems: number; mostly: number; partially: number; notAchieved: number }
export interface OrgBenchmark {
  scope: string;
  modelBenchmark: OrgModelBenchmarkRow[];
  effectiveness: AggEffectiveness[]; // same shape as the public effectiveness aggregate
  members: OrgMemberBenchmarkRow[];
}

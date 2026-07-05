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
  githubUrl: string;
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
}
// Org dashboard settings — admin-writable (GitHub org role captured at sign-in).
export interface OrgSettingsView { scope: string; retentionDays: number | null; dashboardEnabled: boolean; updatedBy: string | null; updatedAt: string | null; viewerRole: string }

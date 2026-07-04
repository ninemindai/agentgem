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
export interface Profile {
  login: string;
  avatarUrl: string | null;
  verified: boolean;
  githubUrl: string;
  totalStars: number;
  gems: ProfileGem[];
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
export interface CuratedSource {
  id: string; label: string; description: string;
  repo: string; ref: string; kind: string;
  license?: string; homepage?: string;
}
export interface SourceDivision { key: string; label: string; icon?: string; color?: string }
export interface SourceAgentRef { division: string; slug: string; name: string; path: string }
export interface ImportedSkill { name: string; description?: string; content: string; source?: string }

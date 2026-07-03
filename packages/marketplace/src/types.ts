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

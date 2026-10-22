export interface Publication {
  space: string;
  id: string;
  sequence: number;
  run: string;
  /** Stable page identity selected as this publication’s home, or empty for fallback. */
  home: string;
  created: string;
}

export type PropertyValue = string | number | boolean | null | string[];
export type Properties = Record<string, PropertyValue>;

export interface PageSummary {
  publishedAt?: string;
  /** Immutable revision identity. */
  id: string;
  /** Stable page identity. */
  page: string;
  slug: string;
  kind: string;
  title: string;
  summary: string;
  properties?: Properties;
}

export interface Source {
  id: string;
  title: string;
  original_name: string;
  original: string;
  media_type: string;
  source_date: string;
  sha256: string;
}

export interface Passage {
  id: string;
  ordinal: number;
  locator: string;
  body: string;
}

export interface Citation {
  id: string;
  marker: string;
  note: string;
  passage: Passage;
  source: Source;
}

export interface PageDetail extends PageSummary {
  body: string;
  property_evidence?: Record<string, string[]>;
  citations: Citation[];
  backlinks: PageSummary[];
  links: PageSummary[];
}

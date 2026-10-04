/** Normalized ingest output. Every input format collapses to this one shape. */
export type SourceKind = 'pptx' | 'pdf' | 'docx' | 'image';

export interface LectureBlock {
  /** Stable id. Every generated item cites one or more of these. */
  id: string;
  /** Slide number / page / image index, 1-based, in true presentation order. */
  ordinal: number;
  heading?: string;
  body: string;
  /** PowerPoint speaker notes -- often the richest content in a lecture deck. */
  speakerNotes?: string;
  tables?: string[][];
  /** Paths to media extracted from the source, for vision passes. */
  imageRefs?: string[];
}

export interface LectureDoc {
  id: string;
  sourceFile: string;
  kind: SourceKind;
  title: string;
  blocks: LectureBlock[];
  /** Non-fatal problems encountered during parsing (unreadable media, etc.). */
  warnings: string[];
}

/** Licence tier governs what the generator is permitted to do with a source. */
export type LicenseTier =
  | 'A' // CC BY / CC0 / US-Gov public domain: ingest, store, remix freely
  | 'B' // CC BY-NC-ND: unaltered excerpt + attribution only, NO paraphrasing
  | 'C' // copyrighted but free to read: paraphrase + cite + deep-link, never bulk-store
  | 'D'; // proprietary: cite by name only, zero content

export interface Citation {
  sourceId: string;
  licenseTier: LicenseTier;
  /** Structured, so APA 7 can be rendered on demand rather than stored as a string. */
  groupOrAuthors: string;
  year: string;
  title: string;
  container?: string;
  edition?: string;
  doiOrUrl?: string;
  retrievedAt?: string;
  /** Required for tier B: the verbatim span being excerpted. */
  verbatimExcerpt?: string;
  licenseUrl?: string;
}

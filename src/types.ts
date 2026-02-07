/**
 * TypeScript type definitions for the PR Notes extension
 */

// Segment classification types
export type SegmentClassification =
  | "Ignore"
  | "Question"
  | "Concern"
  | "Suggestion"
  | "Style";

export const VALID_CLASSIFICATIONS: SegmentClassification[] = [
  "Ignore",
  "Question",
  "Concern",
  "Suggestion",
  "Style",
];

export interface SpeakerSegment {
  speakerTag: number;
  text: string;
  startTime: number;
  endTime: number;
}

/** One sentence (or short phrase) with time span; used for semantic chunking */
export interface TranscriptUnit {
  text: string;
  startTime: number;
  endTime: number;
  speakerTag: number;
}

/** Pending tail between batches: last chunk's units + embeddings for cross-batch merging */
export interface SemanticChunkingTail {
  units: TranscriptUnit[];
  embeddings: number[][];
}

export interface ClassifiedSegment extends SpeakerSegment {
  classification: SegmentClassification;
}

export interface TransformedSegment extends ClassifiedSegment {
  transformedText: string;
}

export interface CandidateLocation {
  timestamp: number;
  file: string;
  cursorLine: number;
  visibleRange: [number, number];
  symbolsInView: string[];
  codeContext: string;
}

export interface LocationSelection {
  selectedIndex: number;
  rationale?: string;
}

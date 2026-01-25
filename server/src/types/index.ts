/**
 * Shared types for the transcription server
 */

export type SegmentClassification = 'Ignore' | 'Question' | 'Concern' | 'Suggestion' | 'Style';

export const VALID_CLASSIFICATIONS: SegmentClassification[] = [
  'Ignore',
  'Question',
  'Concern',
  'Suggestion',
  'Style'
];

export interface SpeakerSegment {
  speakerTag: number;
  text: string;
  startTime: number;
  endTime: number;
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

export interface BatchLocationSelectionRequest {
  segments: Array<{
    commentText: string;
    classification: SegmentClassification;
    timestamp: number;
    fileName: string;
  }>;
  candidates: Array<CandidateLocation[]>;
}

export interface BatchLocationSelectionResponse {
  locations: Array<{
    selectedIndex: number;
    rationale?: string;
  }>;
}

// Error response types - using generics to reduce duplication
type WithError<T> = T & { error: string };

export interface BatchLocationSelectionErrorResponse extends WithError<BatchLocationSelectionResponse> {
  locations: [];
}

// Diar-service types
export interface DiarizationSpeakerSegment {
  speaker: string;
  start: number;
  end: number;
  duration: number;
}

export interface DiarizationResponse {
  success: boolean;
  segments: DiarizationSpeakerSegment[];
  total_speakers: number;
  total_duration: number;
  message?: string;
}

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

export interface ClassificationRequest {
  segments: SpeakerSegment[];
}

export interface ClassificationResponse {
  classifiedSegments: ClassifiedSegment[];
}

export interface TransformationRequest {
  classifiedSegments: ClassifiedSegment[];
}

export interface TransformationResponse {
  transformedSegments: TransformedSegment[];
}

export interface SplitRequest {
  classifiedSegments: ClassifiedSegment[];
}

export interface SplitResponse {
  splitSegments: ClassifiedSegment[];
}

export interface CandidateLocation {
  timestamp: number;
  file: string;
  cursorLine: number;
  visibleRange: [number, number];
  symbolsInView: string[];
  codeContext: string;
}

export interface LocationSelectionRequest {
  commentText: string;
  classification: SegmentClassification;
  candidates: CandidateLocation[];
  fileName: string;
}

export interface LocationSelectionResponse {
  selectedIndex: number;
  rationale?: string;
}

// Error response types
export interface ClassificationErrorResponse extends ClassificationResponse {
  classifiedSegments: [];
  error: string;
}

export interface TransformationErrorResponse extends TransformationResponse {
  transformedSegments: [];
  error: string;
}

export interface SplitErrorResponse extends SplitResponse {
  splitSegments: [];
  error: string;
}

export interface LocationSelectionErrorResponse extends LocationSelectionResponse {
  selectedIndex: 0;
  error: string;
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

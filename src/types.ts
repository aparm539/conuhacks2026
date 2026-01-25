/**
 * TypeScript type definitions for the PR Notes extension
 */

// Legacy diarization types (kept for compatibility)
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

export interface ErrorResponse {
    success: boolean;
    error: string;
    message?: string;
}

export interface HealthResponse {
    status: string;
    service: string;
    pipeline_loaded: boolean;
}

export interface ApiConfig {
    baseUrl: string;
    timeout?: number;
}

// Segment classification types
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

export interface LocationSelection {
    selectedIndex: number;
    rationale?: string;
}

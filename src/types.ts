/**
 * TypeScript type definitions for the Speaker Diarization API
 */

// Shared segment types (also defined in server/src/types/index.ts - keep in sync)
export type SegmentClassification = 'Ignore' | 'Question' | 'Concern' | 'Suggestion' | 'Style';

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

// Note: SpeakerSegment for diarization service uses different field names
// This matches DiarizationSpeakerSegment from server types
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

export interface ApiConfig {
    baseUrl: string;
    timeout?: number;
}

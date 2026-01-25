/**
 * TypeScript type definitions for the Speaker Diarization API
 */

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

export interface HealthResponse {
    status: string;
    service: string;
    pipeline_loaded: boolean;
}

export interface ApiConfig {
    baseUrl: string;
    timeout?: number;
}

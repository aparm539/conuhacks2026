/**
 * TypeScript type definitions for the Speaker Diarization API
 */

export interface SpeakerSegment {
    speaker: string;
    start: number;
    end: number;
    duration: number;
}

export interface DiarizationResponse {
    success: boolean;
    segments: SpeakerSegment[];
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

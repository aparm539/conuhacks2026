/**
 * Centralized configuration constants
 */

// Batch processing constants
export const BATCH_SIZE_CLASSIFY = 7; // Process 5-10 segments per batch, using 7 as middle ground
export const BATCH_SIZE_TRANSFORM = 7; // Process 5-10 segments per batch, using 7 as middle ground
export const BATCH_SIZE_SPLIT = 5; // Process fewer segments at a time for splitting analysis
export const CONTEXT_SIZE = 2; // Include 1-2 segments before/after for context

// Audio processing constants
export const SAMPLE_RATES = [16000, 44100, 48000]; // Common sample rates to try
export const DEFAULT_SAMPLE_RATE = 16000;
export const DEFAULT_ENCODING = 'LINEAR16' as const;
export const DIARIZATION_TIMEOUT_MS = 300000; // 5 minute timeout for diarization

// Request limits
export const MAX_REQUEST_BODY_SIZE = '10mb';

// Gemini model
export const GEMINI_MODEL = 'gemini-3-flash-preview';

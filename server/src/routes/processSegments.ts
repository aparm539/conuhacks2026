import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { processSegmentsUnified } from '../services/gemini';
import { validateSpeakerSegments } from '../utils/validation';
import { requireGeminiClient, validateArray } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import type { 
  SpeakerSegment, 
  TransformedSegment 
} from '../types/index';

interface ProcessSegmentsRequest {
  segments: SpeakerSegment[];
}

interface ProcessSegmentsResponse {
  transformedSegments: TransformedSegment[];
}

interface ProcessSegmentsErrorResponse {
  transformedSegments: [];
  error: string;
}

/**
 * Unified endpoint that combines classify, split, and transform operations
 * This reduces API calls from ~10+ to 1-2 per audio file
 */
export function createProcessSegmentsRoute(geminiClient: GoogleGenerativeAI | null) {
  return asyncHandler(async (
    req: Request<{}, ProcessSegmentsResponse, ProcessSegmentsRequest>,
    res: Response<ProcessSegmentsResponse | ProcessSegmentsErrorResponse>
  ) => {
    const client = requireGeminiClient(geminiClient);
    const segments = validateArray<SpeakerSegment>(req.body.segments, 'segments');

    // Early return for empty arrays
    if (segments.length === 0) {
      return res.json({ transformedSegments: [] });
    }

    // Validate segment structure
    if (!validateSpeakerSegments(segments)) {
      return res.status(400).json({
        transformedSegments: [],
        error: 'Invalid segment structure. Expected { speakerTag: number, text: string, startTime: number, endTime: number }'
      } as ProcessSegmentsErrorResponse);
    }

    // Process segments through unified pipeline
    const transformedSegments = await processSegmentsUnified(segments, client);
    res.json({ transformedSegments });
  });
}

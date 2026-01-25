import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { 
  classifySegmentsSequentially, 
  splitSegmentsSequentially, 
  transformSegmentsSequentially 
} from '../services/gemini';
import { validateSpeakerSegments } from '../utils/validation';
import type { 
  ProcessSegmentsRequest, 
  ProcessSegmentsResponse, 
  ProcessSegmentsErrorResponse 
} from '../types/index';
import { asyncHandler } from '../middleware/errorHandler';

/**
 * Combined endpoint that processes segments through classify, split, and transform
 * in a single request, reducing HTTP round-trips and enabling internal optimizations
 */
export function createProcessSegmentsRoute(geminiClient: GoogleGenerativeAI | null) {
  return asyncHandler(async (
    req: Request<{}, ProcessSegmentsResponse, ProcessSegmentsRequest>,
    res: Response<ProcessSegmentsResponse | ProcessSegmentsErrorResponse>
  ) => {
    const startTime = Date.now();
    console.log('[ProcessSegments] Starting combined segment processing...');

    if (!geminiClient) {
      return res.status(500).json({ 
        transformedSegments: [],
        error: 'Gemini client not initialized. Check server logs for API key errors.' 
      } as ProcessSegmentsErrorResponse);
    }

    const { segments } = req.body;

    if (!segments || !Array.isArray(segments)) {
      return res.status(400).json({ 
        transformedSegments: [],
        error: 'Missing or invalid segments data. Expected array of segments.' 
      } as ProcessSegmentsErrorResponse);
    }

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

    try {
      // Step 1: Classify segments
      console.log(`[ProcessSegments] Step 1/3: Classifying ${segments.length} segments...`);
      const classifyStart = Date.now();
      const classifiedSegments = await classifySegmentsSequentially(segments, geminiClient);
      console.log(`[ProcessSegments] Classification complete in ${Date.now() - classifyStart}ms`);

      // Early filtering: count Ignore segments
      const nonIgnoreCount = classifiedSegments.filter(s => s.classification !== 'Ignore').length;
      console.log(`[ProcessSegments] ${nonIgnoreCount}/${classifiedSegments.length} segments are non-Ignore`);

      if (nonIgnoreCount === 0) {
        console.log('[ProcessSegments] All segments classified as Ignore, returning empty');
        return res.json({ transformedSegments: [] });
      }

      // Step 2: Split segments (handles long segments and duplicates)
      console.log(`[ProcessSegments] Step 2/3: Splitting ${classifiedSegments.length} segments...`);
      const splitStart = Date.now();
      const splitSegments = await splitSegmentsSequentially(classifiedSegments, geminiClient);
      console.log(`[ProcessSegments] Splitting complete in ${Date.now() - splitStart}ms (${splitSegments.length} segments after split)`);

      if (splitSegments.length === 0) {
        console.log('[ProcessSegments] No segments after splitting, returning empty');
        return res.json({ transformedSegments: [] });
      }

      // Step 3: Transform segments (polishes text, filters Ignore)
      console.log(`[ProcessSegments] Step 3/3: Transforming ${splitSegments.length} segments...`);
      const transformStart = Date.now();
      const transformedSegments = await transformSegmentsSequentially(splitSegments, geminiClient);
      console.log(`[ProcessSegments] Transformation complete in ${Date.now() - transformStart}ms`);

      const totalTime = Date.now() - startTime;
      console.log(`[ProcessSegments] Complete: ${segments.length} input -> ${transformedSegments.length} output in ${totalTime}ms`);

      res.json({ transformedSegments });
    } catch (error) {
      console.error('[ProcessSegments] Error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      res.status(500).json({ 
        transformedSegments: [],
        error: `Processing failed: ${errorMessage}` 
      } as ProcessSegmentsErrorResponse);
    }
  });
}

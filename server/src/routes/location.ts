import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { selectCommentLocationsBatch } from '../services/gemini';
import type { 
  BatchLocationSelectionRequest,
  BatchLocationSelectionResponse,
  BatchLocationSelectionErrorResponse,
} from '../types/index';
import { VALID_CLASSIFICATIONS } from '../types';
import { asyncHandler } from '../middleware/errorHandler';
import { requireGeminiClient, validateArray, validateCandidateLocations } from '../middleware/validation';

export function createBatchLocationRoute(geminiClient: GoogleGenerativeAI | null) {
  return asyncHandler(async (
    req: Request<{}, BatchLocationSelectionResponse, BatchLocationSelectionRequest>,
    res: Response<BatchLocationSelectionResponse | BatchLocationSelectionErrorResponse>
  ) => {
    const client = requireGeminiClient(geminiClient);
    const { segments, candidates } = req.body;

    const validatedSegments = validateArray<unknown>(segments, 'segments');
    if (validatedSegments.length === 0) {
      console.error('[API] ERROR: Empty segments array');
      return res.status(400).json({ 
        locations: [],
        error: 'Missing or invalid segments. Expected non-empty array.' 
      } as BatchLocationSelectionErrorResponse);
    }

    const validatedCandidates = validateArray<unknown>(candidates, 'candidates');
    if (validatedCandidates.length !== validatedSegments.length) {
      console.error(`[API] ERROR: Mismatch between segments (${validatedSegments.length}) and candidates (${validatedCandidates.length})`);
      return res.status(400).json({ 
        locations: [],
        error: `Mismatch: ${validatedSegments.length} segments but ${validatedCandidates.length} candidate arrays. Expected equal counts.` 
      } as BatchLocationSelectionErrorResponse);
    }

    // Validate segment structure
    for (let i = 0; i < validatedSegments.length; i++) {
      const segment = validatedSegments[i] as any;
      if (
        typeof segment.commentText !== 'string' ||
        !segment.classification ||
        !VALID_CLASSIFICATIONS.includes(segment.classification) ||
        typeof segment.timestamp !== 'number' ||
        typeof segment.fileName !== 'string'
      ) {
        console.error(`[API] ERROR: Invalid segment structure at index ${i}`);
        return res.status(400).json({ 
          locations: [],
          error: `Invalid segment structure at index ${i}. Expected { commentText: string, classification: SegmentClassification, timestamp: number, fileName: string }` 
        } as BatchLocationSelectionErrorResponse);
      }
    }

    // Validate candidate arrays
    for (let i = 0; i < validatedCandidates.length; i++) {
      const candidateArray = validatedCandidates[i];
      if (!Array.isArray(candidateArray) || candidateArray.length === 0) {
        console.error(`[API] ERROR: Invalid candidate array at index ${i}: ${candidateArray ? 'empty array' : 'not array'}`);
        return res.status(400).json({ 
          locations: [],
          error: `Invalid candidate array at index ${i}. Expected non-empty array of CandidateLocation.` 
        } as BatchLocationSelectionErrorResponse);
      }

      // Validate each candidate in the array
      try {
        validateCandidateLocations(candidateArray as unknown[]);
      } catch (error) {
        console.error(`[API] ERROR: Invalid candidate structure at segment ${i}`, error);
        return res.status(400).json({ 
          locations: [],
          error: error instanceof Error ? error.message : `Invalid candidate structure at segment ${i}` 
        } as BatchLocationSelectionErrorResponse);
      }
    }

    const locations = await selectCommentLocationsBatch(
      validatedSegments as any,
      validatedCandidates as any,
      client
    );
    res.json({ locations });
  });
}

import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { selectCommentLocation, selectCommentLocationsBatch } from '../services/gemini';
import type { 
  LocationSelectionRequest, 
  LocationSelectionResponse, 
  LocationSelectionErrorResponse,
  BatchLocationSelectionRequest,
  BatchLocationSelectionResponse,
  BatchLocationSelectionErrorResponse,
  SegmentClassification 
} from '../types/index';
import { VALID_CLASSIFICATIONS } from '../types';
import { asyncHandler } from '../middleware/errorHandler';
import { requireGeminiClient, validateArray, validateCandidateLocation, validateCandidateLocations } from '../middleware/validation';

export function createLocationRoute(geminiClient: GoogleGenerativeAI | null) {
  return asyncHandler(async (
    req: Request<{}, LocationSelectionResponse, LocationSelectionRequest>,
    res: Response<LocationSelectionResponse | LocationSelectionErrorResponse>
  ) => {
    console.log(`[API] POST /select-comment-location - Request received`);
    
    const client = requireGeminiClient(geminiClient);
    const { commentText, classification, candidates, fileName } = req.body;
    console.log(`[API] Request body: commentText="${commentText?.substring(0, 50)}${commentText?.length > 50 ? '...' : ''}", classification=${classification}, fileName=${fileName}, candidates=${candidates?.length || 0}`);

    if (!commentText || typeof commentText !== 'string') {
      console.error('[API] ERROR: Missing or invalid commentText');
      return res.status(400).json({ 
        selectedIndex: 0,
        error: 'Missing or invalid commentText. Expected string.' 
      } as LocationSelectionErrorResponse);
    }

    if (!classification || !VALID_CLASSIFICATIONS.includes(classification)) {
      console.error(`[API] ERROR: Missing or invalid classification: ${classification}`);
      return res.status(400).json({ 
        selectedIndex: 0,
        error: 'Missing or invalid classification. Expected one of: Ignore, Question, Concern, Suggestion, Style.' 
      } as LocationSelectionErrorResponse);
    }

    const validatedCandidates = validateArray<unknown>(candidates, 'candidates');
    if (validatedCandidates.length === 0) {
      console.error(`[API] ERROR: Empty candidates array`);
      return res.status(400).json({ 
        selectedIndex: 0,
        error: 'Missing or invalid candidates. Expected non-empty array of CandidateLocation.' 
      } as LocationSelectionErrorResponse);
    }

    // Validate candidate structure
    console.log(`[API] Validating ${validatedCandidates.length} candidate(s)...`);
    try {
      validateCandidateLocations(validatedCandidates);
    } catch (error) {
      return res.status(400).json({ 
        selectedIndex: 0,
        error: error instanceof Error ? error.message : 'Invalid candidate structure' 
      } as LocationSelectionErrorResponse);
    }
    console.log(`[API] ✓ All candidates validated successfully`);

    console.log(`[API] Calling selectCommentLocation function...`);
    const selection = await selectCommentLocation(
      commentText,
      classification as SegmentClassification,
      validatedCandidates as any,
      fileName || '',
      client
    );
    console.log(`[API] ✓ Location selection completed: index=${selection.selectedIndex}`);
    res.json(selection);
  });
}

export function createBatchLocationRoute(geminiClient: GoogleGenerativeAI | null) {
  return asyncHandler(async (
    req: Request<{}, BatchLocationSelectionResponse, BatchLocationSelectionRequest>,
    res: Response<BatchLocationSelectionResponse | BatchLocationSelectionErrorResponse>
  ) => {
    console.log(`[API] POST /select-comment-locations - Batch request received`);
    
    const client = requireGeminiClient(geminiClient);
    const { segments, candidates } = req.body;
    console.log(`[API] Request body: ${segments?.length || 0} segment(s), ${candidates?.length || 0} candidate array(s)`);

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
    console.log(`[API] Validating ${validatedSegments.length} segment(s)...`);
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
    console.log(`[API] Validating ${validatedCandidates.length} candidate array(s)...`);
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
        console.error(`[API] ERROR: Invalid candidate structure at segment ${i}`);
        return res.status(400).json({ 
          locations: [],
          error: error instanceof Error ? error.message : `Invalid candidate structure at segment ${i}` 
        } as BatchLocationSelectionErrorResponse);
      }
    }
    console.log(`[API] ✓ All segments and candidates validated successfully`);

    console.log(`[API] Calling selectCommentLocationsBatch function...`);
    const locations = await selectCommentLocationsBatch(
      validatedSegments as any,
      validatedCandidates as any,
      client
    );
    console.log(`[API] ✓ Batch location selection completed: ${locations.length} location(s)`);
    res.json({ locations });
  });
}

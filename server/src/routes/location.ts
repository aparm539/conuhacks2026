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

const GEMINI_KEY_401_MSG = 'Missing Gemini API key. Set it in the extension (Command: PR Notes: Set Gemini API Key).';

function getGeminiKey(req: Request): string | null {
  const key = req.headers['x-gemini-api-key'];
  if (typeof key !== 'string' || !key.trim()) return null;
  return key.trim();
}

export function createLocationRoute() {
  return asyncHandler(async (
    req: Request<{}, LocationSelectionResponse, LocationSelectionRequest>,
    res: Response<LocationSelectionResponse | LocationSelectionErrorResponse>
  ) => {
    console.log(`[API] POST /select-comment-location - Request received`);

    const apiKey = getGeminiKey(req);
    if (!apiKey) {
      console.error('[API] ERROR: Missing X-Gemini-Api-Key header');
      return res.status(401).json({
        selectedIndex: 0,
        error: GEMINI_KEY_401_MSG,
      } as LocationSelectionErrorResponse);
    }

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

    if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
      console.error(`[API] ERROR: Missing or invalid candidates: ${candidates ? 'empty array' : 'missing'}`);
      return res.status(400).json({ 
        selectedIndex: 0,
        error: 'Missing or invalid candidates. Expected non-empty array of CandidateLocation.' 
      } as LocationSelectionErrorResponse);
    }

    // Validate candidate structure
    console.log(`[API] Validating ${candidates.length} candidate(s)...`);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (
        typeof candidate.timestamp !== 'number' ||
        typeof candidate.file !== 'string' ||
        typeof candidate.cursorLine !== 'number' ||
        !Array.isArray(candidate.visibleRange) ||
        candidate.visibleRange.length !== 2 ||
        !Array.isArray(candidate.symbolsInView) ||
        typeof candidate.codeContext !== 'string'
      ) {
        console.error(`[API] ERROR: Invalid candidate structure at index ${i}:`, {
          timestamp: typeof candidate.timestamp,
          file: typeof candidate.file,
          cursorLine: typeof candidate.cursorLine,
          visibleRange: Array.isArray(candidate.visibleRange) ? candidate.visibleRange.length : 'not array',
          symbolsInView: Array.isArray(candidate.symbolsInView) ? 'array' : 'not array',
          codeContext: typeof candidate.codeContext
        });
        return res.status(400).json({ 
          selectedIndex: 0,
          error: 'Invalid candidate structure. Expected CandidateLocation with all required fields.' 
        } as LocationSelectionErrorResponse);
      }
    }
    console.log(`[API] ✓ All candidates validated successfully`);

    try {
      const geminiClient = new GoogleGenerativeAI(apiKey);
      console.log(`[API] Calling selectCommentLocation function...`);
      const selection = await selectCommentLocation(
        commentText,
        classification as SegmentClassification,
        candidates,
        fileName || '',
        geminiClient
      );
      console.log(`[API] ✓ Location selection completed: index=${selection.selectedIndex}`);
      res.json(selection);
    } catch (error) {
      console.error('[API] ERROR: Location selection failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      res.status(500).json({
        selectedIndex: 0,
        error: `Location selection failed: ${errorMessage}`,
      } as LocationSelectionErrorResponse);
    }
  });
}

export function createBatchLocationRoute() {
  return asyncHandler(async (
    req: Request<{}, BatchLocationSelectionResponse, BatchLocationSelectionRequest>,
    res: Response<BatchLocationSelectionResponse | BatchLocationSelectionErrorResponse>
  ) => {
    console.log(`[API] POST /select-comment-locations - Batch request received`);

    const apiKey = getGeminiKey(req);
    if (!apiKey) {
      console.error('[API] ERROR: Missing X-Gemini-Api-Key header');
      return res.status(401).json({
        locations: [],
        error: GEMINI_KEY_401_MSG,
      } as BatchLocationSelectionErrorResponse);
    }

    const { segments, candidates } = req.body;
    console.log(`[API] Request body: ${segments?.length || 0} segment(s), ${candidates?.length || 0} candidate array(s)`);

    if (!segments || !Array.isArray(segments) || segments.length === 0) {
      console.error('[API] ERROR: Missing or invalid segments');
      return res.status(400).json({ 
        locations: [],
        error: 'Missing or invalid segments. Expected non-empty array.' 
      } as BatchLocationSelectionErrorResponse);
    }

    if (!candidates || !Array.isArray(candidates) || candidates.length !== segments.length) {
      console.error(`[API] ERROR: Mismatch between segments (${segments.length}) and candidates (${candidates?.length || 0})`);
      return res.status(400).json({ 
        locations: [],
        error: `Mismatch: ${segments.length} segments but ${candidates?.length || 0} candidate arrays. Expected equal counts.` 
      } as BatchLocationSelectionErrorResponse);
    }

    // Validate segment structure
    console.log(`[API] Validating ${segments.length} segment(s)...`);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
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
    console.log(`[API] Validating ${candidates.length} candidate array(s)...`);
    for (let i = 0; i < candidates.length; i++) {
      const candidateArray = candidates[i];
      if (!Array.isArray(candidateArray) || candidateArray.length === 0) {
        console.error(`[API] ERROR: Invalid candidate array at index ${i}: ${candidateArray ? 'empty array' : 'not array'}`);
        return res.status(400).json({ 
          locations: [],
          error: `Invalid candidate array at index ${i}. Expected non-empty array of CandidateLocation.` 
        } as BatchLocationSelectionErrorResponse);
      }

      // Validate each candidate in the array
      for (let j = 0; j < candidateArray.length; j++) {
        const candidate = candidateArray[j];
        if (
          typeof candidate.timestamp !== 'number' ||
          typeof candidate.file !== 'string' ||
          typeof candidate.cursorLine !== 'number' ||
          !Array.isArray(candidate.visibleRange) ||
          candidate.visibleRange.length !== 2 ||
          !Array.isArray(candidate.symbolsInView) ||
          typeof candidate.codeContext !== 'string'
        ) {
          console.error(`[API] ERROR: Invalid candidate structure at segment ${i}, candidate ${j}`);
          return res.status(400).json({ 
            locations: [],
            error: `Invalid candidate structure at segment ${i}, candidate ${j}. Expected CandidateLocation with all required fields.` 
          } as BatchLocationSelectionErrorResponse);
        }
      }
    }
    console.log(`[API] ✓ All segments and candidates validated successfully`);

    try {
      const geminiClient = new GoogleGenerativeAI(apiKey);
      console.log(`[API] Calling selectCommentLocationsBatch function...`);
      const locations = await selectCommentLocationsBatch(
        segments,
        candidates,
        geminiClient
      );
      console.log(`[API] ✓ Batch location selection completed: ${locations.length} location(s)`);
      res.json({ locations });
    } catch (error) {
      console.error('[API] ERROR: Batch location selection failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      res.status(500).json({
        locations: [],
        error: `Batch location selection failed: ${errorMessage}`,
      } as BatchLocationSelectionErrorResponse);
    }
  });
}

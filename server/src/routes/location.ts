import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { selectCommentLocation } from '../services/gemini';
import type { LocationSelectionRequest, LocationSelectionResponse, LocationSelectionErrorResponse, SegmentClassification } from '../types/index';
import { VALID_CLASSIFICATIONS } from '../types';
import { asyncHandler } from '../middleware/errorHandler';

export function createLocationRoute(geminiClient: GoogleGenerativeAI | null) {
  return asyncHandler(async (
    req: Request<{}, LocationSelectionResponse, LocationSelectionRequest>,
    res: Response<LocationSelectionResponse | LocationSelectionErrorResponse>
  ) => {
    console.log(`[API] POST /select-comment-location - Request received`);
    
    if (!geminiClient) {
      console.error('[API] ERROR: Gemini client not initialized');
      return res.status(500).json({ 
        selectedIndex: 0,
        error: 'Gemini client not initialized. Check server logs for API key errors.' 
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
        error: `Location selection failed: ${errorMessage}` 
      } as LocationSelectionErrorResponse);
    }
  });
}

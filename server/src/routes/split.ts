import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { splitSegmentsSequentially } from '../services/gemini';
import { validateClassifiedSegments } from '../utils/validation';
import { requireGeminiClient, validateArray } from '../middleware/validation';
import type { SplitRequest, SplitResponse, SplitErrorResponse } from '../types/index';
import { asyncHandler } from '../middleware/errorHandler';

export function createSplitRoute(geminiClient: GoogleGenerativeAI | null) {
  return asyncHandler(async (
    req: Request<{}, SplitResponse, SplitRequest>,
    res: Response<SplitResponse | SplitErrorResponse>
  ) => {
    const client = requireGeminiClient(geminiClient);
    const classifiedSegments = validateArray<unknown>(req.body.classifiedSegments, 'classifiedSegments');

    if (classifiedSegments.length === 0) {
      return res.json({ splitSegments: [] });
    }

    // Validate segment structure
    if (!validateClassifiedSegments(classifiedSegments)) {
      return res.status(400).json({ 
        splitSegments: [],
        error: 'Invalid segment structure. Expected ClassifiedSegment with classification field.' 
      } as SplitErrorResponse);
    }

    const splitSegments = await splitSegmentsSequentially(classifiedSegments, client);
    res.json({ splitSegments });
  });
}

import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { transformSegmentsSequentially } from '../services/gemini';
import { validateClassifiedSegments } from '../utils/validation';
import { requireGeminiClient, validateArray } from '../middleware/validation';
import type { TransformationRequest, TransformationResponse, TransformationErrorResponse } from '../types/index';
import { asyncHandler } from '../middleware/errorHandler';

export function createTransformRoute(geminiClient: GoogleGenerativeAI | null) {
  return asyncHandler(async (
    req: Request<{}, TransformationResponse, TransformationRequest>,
    res: Response<TransformationResponse | TransformationErrorResponse>
  ) => {
    const client = requireGeminiClient(geminiClient);
    const classifiedSegments = validateArray<unknown>(req.body.classifiedSegments, 'classifiedSegments');

    if (classifiedSegments.length === 0) {
      return res.json({ transformedSegments: [] });
    }

    // Validate segment structure
    if (!validateClassifiedSegments(classifiedSegments)) {
      return res.status(400).json({ 
        transformedSegments: [],
        error: 'Invalid segment structure. Expected ClassifiedSegment with classification field.' 
      } as TransformationErrorResponse);
    }

    const transformedSegments = await transformSegmentsSequentially(classifiedSegments, client);
    res.json({ transformedSegments });
  });
}

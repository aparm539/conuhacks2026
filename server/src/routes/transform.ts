import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { transformSegmentsSequentially } from '../services/gemini';
import { validateClassifiedSegments } from '../utils/validation';
import type { TransformationRequest, TransformationResponse, TransformationErrorResponse } from '../types/index';
import { asyncHandler } from '../middleware/errorHandler';

export function createTransformRoute(geminiClient: GoogleGenerativeAI | null) {
  return asyncHandler(async (
    req: Request<{}, TransformationResponse, TransformationRequest>,
    res: Response<TransformationResponse | TransformationErrorResponse>
  ) => {
    if (!geminiClient) {
      return res.status(500).json({ 
        transformedSegments: [],
        error: 'Gemini client not initialized. Check server logs for API key errors.' 
      } as TransformationErrorResponse);
    }

    const { classifiedSegments } = req.body;

    if (!classifiedSegments || !Array.isArray(classifiedSegments)) {
      return res.status(400).json({ 
        transformedSegments: [],
        error: 'Missing or invalid classifiedSegments data. Expected array of ClassifiedSegment.' 
      } as TransformationErrorResponse);
    }

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

    try {
      const transformedSegments = await transformSegmentsSequentially(classifiedSegments, geminiClient);
      res.json({ transformedSegments });
    } catch (error) {
      console.error('Transformation error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      res.status(500).json({ 
        transformedSegments: [],
        error: `Transformation failed: ${errorMessage}` 
      } as TransformationErrorResponse);
    }
  });
}

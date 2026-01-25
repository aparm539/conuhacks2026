import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { transformSegmentsSequentially } from '../services/gemini';
import { validateClassifiedSegments } from '../utils/validation';
import type { TransformationRequest, TransformationResponse, TransformationErrorResponse } from '../types/index';
import { asyncHandler } from '../middleware/errorHandler';

const GEMINI_KEY_401_MSG = 'Missing Gemini API key. Set it in the extension (Command: PR Notes: Set Gemini API Key).';

function getGeminiKey(req: Request): string | null {
  const key = req.headers['x-gemini-api-key'];
  if (typeof key !== 'string' || !key.trim()) return null;
  return key.trim();
}

export function createTransformRoute() {
  return asyncHandler(async (
    req: Request<{}, TransformationResponse, TransformationRequest>,
    res: Response<TransformationResponse | TransformationErrorResponse>
  ) => {
    const apiKey = getGeminiKey(req);
    if (!apiKey) {
      return res.status(401).json({
        transformedSegments: [],
        error: GEMINI_KEY_401_MSG,
      } as TransformationErrorResponse);
    }

    const { classifiedSegments } = req.body;

    if (!classifiedSegments || !Array.isArray(classifiedSegments)) {
      return res.status(400).json({
        transformedSegments: [],
        error: 'Missing or invalid classifiedSegments data. Expected array of ClassifiedSegment.',
      } as TransformationErrorResponse);
    }

    if (classifiedSegments.length === 0) {
      return res.json({ transformedSegments: [] });
    }

    if (!validateClassifiedSegments(classifiedSegments)) {
      return res.status(400).json({
        transformedSegments: [],
        error: 'Invalid segment structure. Expected ClassifiedSegment with classification field.',
      } as TransformationErrorResponse);
    }

    try {
      const geminiClient = new GoogleGenerativeAI(apiKey);
      const transformedSegments = await transformSegmentsSequentially(classifiedSegments, geminiClient);
      res.json({ transformedSegments });
    } catch (error) {
      console.error('Transformation error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      res.status(500).json({
        transformedSegments: [],
        error: `Transformation failed: ${errorMessage}`,
      } as TransformationErrorResponse);
    }
  });
}

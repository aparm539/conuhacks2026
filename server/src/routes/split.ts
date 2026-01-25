import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { splitSegmentsSequentially } from '../services/gemini';
import { validateClassifiedSegments } from '../utils/validation';
import type { SplitRequest, SplitResponse, SplitErrorResponse } from '../types/index';
import { asyncHandler } from '../middleware/errorHandler';

const GEMINI_KEY_401_MSG = 'Missing Gemini API key. Set it in the extension (Command: PR Notes: Set Gemini API Key).';

function getGeminiKey(req: Request): string | null {
  const key = req.headers['x-gemini-api-key'];
  if (typeof key !== 'string' || !key.trim()) return null;
  return key.trim();
}

export function createSplitRoute() {
  return asyncHandler(async (
    req: Request<{}, SplitResponse, SplitRequest>,
    res: Response<SplitResponse | SplitErrorResponse>
  ) => {
    const apiKey = getGeminiKey(req);
    if (!apiKey) {
      return res.status(401).json({
        splitSegments: [],
        error: GEMINI_KEY_401_MSG,
      } as SplitErrorResponse);
    }

    const { classifiedSegments } = req.body;

    if (!classifiedSegments || !Array.isArray(classifiedSegments)) {
      return res.status(400).json({
        splitSegments: [],
        error: 'Missing or invalid classifiedSegments data. Expected array of ClassifiedSegment.',
      } as SplitErrorResponse);
    }

    if (classifiedSegments.length === 0) {
      return res.json({ splitSegments: [] });
    }

    if (!validateClassifiedSegments(classifiedSegments)) {
      return res.status(400).json({
        splitSegments: [],
        error: 'Invalid segment structure. Expected ClassifiedSegment with classification field.',
      } as SplitErrorResponse);
    }

    try {
      const geminiClient = new GoogleGenerativeAI(apiKey);
      const splitSegments = await splitSegmentsSequentially(classifiedSegments, geminiClient);
      res.json({ splitSegments });
    } catch (error) {
      console.error('Splitting error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      res.status(500).json({
        splitSegments: [],
        error: `Splitting failed: ${errorMessage}`,
      } as SplitErrorResponse);
    }
  });
}

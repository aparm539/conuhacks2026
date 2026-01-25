import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { classifySegmentsSequentially } from '../services/gemini';
import { validateSpeakerSegments } from '../utils/validation';
import type { ClassificationRequest, ClassificationResponse, ClassificationErrorResponse } from '../types/index';
import { asyncHandler } from '../middleware/errorHandler';

const GEMINI_KEY_401_MSG = 'Missing Gemini API key. Set it in the extension (Command: PR Notes: Set Gemini API Key).';

function getGeminiKey(req: Request): string | null {
  const key = req.headers['x-gemini-api-key'];
  if (typeof key !== 'string' || !key.trim()) return null;
  return key.trim();
}

export function createClassifyRoute() {
  return asyncHandler(async (
    req: Request<{}, ClassificationResponse, ClassificationRequest>,
    res: Response<ClassificationResponse | ClassificationErrorResponse>
  ) => {
    const apiKey = getGeminiKey(req);
    if (!apiKey) {
      return res.status(401).json({
        classifiedSegments: [],
        error: GEMINI_KEY_401_MSG,
      } as ClassificationErrorResponse);
    }

    const { segments } = req.body;

    if (!segments || !Array.isArray(segments)) {
      return res.status(400).json({
        classifiedSegments: [],
        error: 'Missing or invalid segments data. Expected array of segments.',
      } as ClassificationErrorResponse);
    }

    if (segments.length === 0) {
      return res.json({ classifiedSegments: [] });
    }

    if (!validateSpeakerSegments(segments)) {
      return res.status(400).json({
        classifiedSegments: [],
        error: 'Invalid segment structure. Expected { speakerTag: number, text: string, startTime: number, endTime: number }',
      } as ClassificationErrorResponse);
    }

    try {
      const geminiClient = new GoogleGenerativeAI(apiKey);
      const classifiedSegments = await classifySegmentsSequentially(segments, geminiClient);
      res.json({ classifiedSegments });
    } catch (error) {
      console.error('Classification error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      res.status(500).json({
        classifiedSegments: [],
        error: `Classification failed: ${errorMessage}`,
      } as ClassificationErrorResponse);
    }
  });
}

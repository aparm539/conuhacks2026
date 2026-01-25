import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { classifySegmentsSequentially } from '../services/gemini';
import { validateSpeakerSegments } from '../utils/validation';
import { requireGeminiClient, validateArray } from '../middleware/validation';
import type { ClassificationRequest, ClassificationResponse, ClassificationErrorResponse } from '../types/index';
import { asyncHandler } from '../middleware/errorHandler';

export function createClassifyRoute(geminiClient: GoogleGenerativeAI | null) {
  return asyncHandler(async (
    req: Request<{}, ClassificationResponse, ClassificationRequest>,
    res: Response<ClassificationResponse | ClassificationErrorResponse>
  ) => {
    const client = requireGeminiClient(geminiClient);
    const segments = validateArray<unknown>(req.body.segments, 'segments');

    if (segments.length === 0) {
      return res.json({ classifiedSegments: [] });
    }

    // Validate segment structure
    if (!validateSpeakerSegments(segments)) {
      return res.status(400).json({ 
        classifiedSegments: [],
        error: 'Invalid segment structure. Expected { speakerTag: number, text: string, startTime: number, endTime: number }' 
      } as ClassificationErrorResponse);
    }

    const classifiedSegments = await classifySegmentsSequentially(segments, client);
    res.json({ classifiedSegments });
  });
}

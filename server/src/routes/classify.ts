import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { classifySegmentsSequentially } from '../services/gemini';
import { validateSpeakerSegments } from '../utils/validation';
import type { ClassificationRequest, ClassificationResponse, ClassificationErrorResponse } from '../types/index';
import { asyncHandler } from '../middleware/errorHandler';

export function createClassifyRoute(geminiClient: GoogleGenerativeAI | null) {
  return asyncHandler(async (
    req: Request<{}, ClassificationResponse, ClassificationRequest>,
    res: Response<ClassificationResponse | ClassificationErrorResponse>
  ) => {
    if (!geminiClient) {
      return res.status(500).json({ 
        classifiedSegments: [],
        error: 'Gemini client not initialized. Check server logs for API key errors.' 
      } as ClassificationErrorResponse);
    }

    const { segments } = req.body;

    if (!segments || !Array.isArray(segments)) {
      return res.status(400).json({ 
        classifiedSegments: [],
        error: 'Missing or invalid segments data. Expected array of segments.' 
      } as ClassificationErrorResponse);
    }

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

    try {
      const classifiedSegments = await classifySegmentsSequentially(segments, geminiClient);
      res.json({ classifiedSegments });
    } catch (error) {
      console.error('Classification error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      res.status(500).json({ 
        classifiedSegments: [],
        error: `Classification failed: ${errorMessage}` 
      } as ClassificationErrorResponse);
    }
  });
}

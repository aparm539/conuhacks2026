import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { splitSegmentsSequentially } from '../services/gemini';
import { validateClassifiedSegments } from '../utils/validation';
import type { SplitRequest, SplitResponse, SplitErrorResponse } from '../types/index';
import { createPipelineRoute } from './createPipelineRoute';

export function createSplitRoute(geminiClient: GoogleGenerativeAI | null) {
  return createPipelineRoute<SplitRequest, SplitResponse, SplitErrorResponse>(
    geminiClient,
    {
      inputKey: 'classifiedSegments',
      outputKey: 'splitSegments',
      validator: validateClassifiedSegments,
      validationError: 'Invalid segment structure. Expected ClassifiedSegment with classification field.',
      processor: splitSegmentsSequentially,
      createErrorResponse: (error: string) => ({
        splitSegments: [],
        error
      } as SplitErrorResponse)
    }
  );
}

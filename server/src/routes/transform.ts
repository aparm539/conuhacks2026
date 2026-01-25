import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { transformSegmentsSequentially } from '../services/gemini';
import { validateClassifiedSegments } from '../utils/validation';
import type { TransformationRequest, TransformationResponse, TransformationErrorResponse } from '../types/index';
import { createPipelineRoute } from './createPipelineRoute';

export function createTransformRoute(geminiClient: GoogleGenerativeAI | null) {
  return createPipelineRoute<TransformationRequest, TransformationResponse, TransformationErrorResponse>(
    geminiClient,
    {
      inputKey: 'classifiedSegments',
      outputKey: 'transformedSegments',
      validator: validateClassifiedSegments,
      validationError: 'Invalid segment structure. Expected ClassifiedSegment with classification field.',
      processor: transformSegmentsSequentially,
      createErrorResponse: (error: string) => ({
        transformedSegments: [],
        error
      } as TransformationErrorResponse)
    }
  );
}

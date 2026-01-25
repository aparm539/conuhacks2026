import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { classifySegmentsSequentially } from '../services/gemini';
import { validateSpeakerSegments } from '../utils/validation';
import type { ClassificationRequest, ClassificationResponse, ClassificationErrorResponse } from '../types/index';
import { createPipelineRoute } from './createPipelineRoute';

export function createClassifyRoute(geminiClient: GoogleGenerativeAI | null) {
  return createPipelineRoute<ClassificationRequest, ClassificationResponse, ClassificationErrorResponse>(
    geminiClient,
    {
      inputKey: 'segments',
      outputKey: 'classifiedSegments',
      validator: validateSpeakerSegments,
      validationError: 'Invalid segment structure. Expected { speakerTag: number, text: string, startTime: number, endTime: number }',
      processor: classifySegmentsSequentially,
      createErrorResponse: (error: string) => ({
        classifiedSegments: [],
        error
      } as ClassificationErrorResponse)
    }
  );
}

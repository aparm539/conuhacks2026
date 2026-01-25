import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { requireGeminiClient, validateArray } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';

/**
 * Configuration for a pipeline route (classify, split, transform)
 */
interface PipelineRouteConfig<TRequest, TResponse, TErrorResponse> {
  /** Key in request body containing the input array */
  inputKey: keyof TRequest;
  /** Key in response object for the output array */
  outputKey: keyof TResponse;
  /** Validator function for segment structure */
  validator: (segments: unknown[]) => boolean;
  /** Error message when validation fails */
  validationError: string;
  /** Processor function that calls the service */
  processor: (segments: any[], client: GoogleGenerativeAI) => Promise<any[]>;
  /** Function to create error response */
  createErrorResponse: (error: string) => TErrorResponse;
}

/**
 * Create a generic pipeline route handler for classify/split/transform endpoints
 * This reduces boilerplate by handling common patterns:
 * - Client validation
 * - Array validation
 * - Empty array handling
 * - Segment structure validation
 * - Service call and response formatting
 */
export function createPipelineRoute<TRequest, TResponse, TErrorResponse>(
  geminiClient: GoogleGenerativeAI | null,
  config: PipelineRouteConfig<TRequest, TResponse, TErrorResponse>
) {
  return asyncHandler(async (
    req: Request<{}, TResponse, TRequest>,
    res: Response<TResponse | TErrorResponse>
  ) => {
    const client = requireGeminiClient(geminiClient);
    const inputValue = (req.body as any)[config.inputKey];
    const segments = validateArray<unknown>(inputValue, config.inputKey as string);

    // Early return for empty arrays
    if (segments.length === 0) {
      return res.json({ [config.outputKey]: [] } as TResponse);
    }

    // Validate segment structure
    if (!config.validator(segments)) {
      return res.status(400).json(
        config.createErrorResponse(config.validationError)
      );
    }

    // Process segments
    const results = await config.processor(segments, client);
    res.json({ [config.outputKey]: results } as TResponse);
  });
}

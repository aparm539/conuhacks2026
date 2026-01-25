import type { Response } from 'express';
import type {
  ClassificationResponse,
  TransformationResponse,
  SplitResponse,
  LocationSelectionResponse,
} from './index';

/**
 * Error response types for different endpoints
 */
export interface ErrorResponse {
  error: string;
}

export interface ClassificationErrorResponse extends ClassificationResponse, ErrorResponse {
  classifiedSegments: [];
}

export interface TransformationErrorResponse extends TransformationResponse, ErrorResponse {
  transformedSegments: [];
}

export interface SplitErrorResponse extends SplitResponse, ErrorResponse {
  splitSegments: [];
}

export interface LocationSelectionErrorResponse extends LocationSelectionResponse, ErrorResponse {
  selectedIndex: 0;
}

/**
 * Helper function to send error response with proper typing
 */
export function sendErrorResponse<T extends ErrorResponse>(
  res: Response<T>,
  statusCode: number,
  error: string
): void {
  res.status(statusCode).json({ error } as T);
}

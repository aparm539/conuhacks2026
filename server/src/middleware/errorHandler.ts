import type { Request, Response, NextFunction } from 'express';
import { ApiError } from './validation';

/**
 * Centralized error handling middleware
 * Logs errors and sends appropriate error responses
 */
export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  console.error(`[ERROR] ${req.method} ${req.path}:`, error);
  console.error('[ERROR] Stack:', error.stack || 'No stack trace');

  // Handle ApiError with custom status code
  if (error instanceof ApiError) {
    return res.status(error.statusCode).json({
      error: error.message
    });
  }

  // Default to 500 if status code not set
  const statusCode = (res as any).statusCode || 500;
  
  res.status(statusCode).json({
    error: error.message || 'Internal server error'
  });
}

/**
 * Async handler wrapper to catch errors in async route handlers
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

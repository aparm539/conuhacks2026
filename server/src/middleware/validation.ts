import type { Request, Response, NextFunction } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Custom error class for API validation errors
 */
export class ApiError extends Error {
	constructor(public statusCode: number, message: string) {
		super(message);
		this.name = 'ApiError';
	}
}

/**
 * Middleware to require Gemini client
 * Throws ApiError if client is not initialized
 */
export function requireGeminiClient(client: GoogleGenerativeAI | null): GoogleGenerativeAI {
	if (!client) {
		throw new ApiError(500, 'Gemini client not initialized. Check server logs for API key errors.');
	}
	return client;
}

/**
 * Validate that a value is a non-empty array
 * Throws ApiError if validation fails
 */
export function validateArray<T>(arr: unknown, name: string): T[] {
	if (!arr || !Array.isArray(arr)) {
		throw new ApiError(400, `Missing or invalid ${name}. Expected array.`);
	}
	return arr;
}

/**
 * Validate candidate location structure
 * Throws ApiError if validation fails
 */
export function validateCandidateLocation(candidate: unknown, index?: number): void {
	const prefix = index !== undefined ? `at index ${index}` : '';
	
	if (!candidate || typeof candidate !== 'object') {
		throw new ApiError(400, `Invalid candidate structure ${prefix}. Expected object.`);
	}
	
	const c = candidate as Record<string, unknown>;
	
	if (typeof c.timestamp !== 'number' ||
		typeof c.file !== 'string' ||
		typeof c.cursorLine !== 'number' ||
		!Array.isArray(c.visibleRange) ||
		c.visibleRange.length !== 2 ||
		!Array.isArray(c.symbolsInView) ||
		typeof c.codeContext !== 'string') {
		throw new ApiError(400, `Invalid candidate structure ${prefix}. Expected CandidateLocation with all required fields.`);
	}
}

/**
 * Validate array of candidate locations
 * Throws ApiError if validation fails
 */
export function validateCandidateLocations(candidates: unknown[]): void {
	for (let i = 0; i < candidates.length; i++) {
		validateCandidateLocation(candidates[i], i);
	}
}

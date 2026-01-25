import * as vscode from 'vscode';
import { RecordingContext } from './contextCollector';
import { selectCommentLocationsBatch } from './services/gemini';
import type { CandidateLocation } from './types';

export interface WordInfo {
	word: string;
	speakerTag: number;
	startOffset: string;
	endOffset: string;
}

export interface SpeakerSegment {
	speakerTag: number;
	text: string;
	startTime: number;
	endTime: number;
}

export type SegmentClassification = 'Ignore' | 'Question' | 'Concern' | 'Suggestion' | 'Style';

export interface ClassifiedSegment extends SpeakerSegment {
	classification: SegmentClassification;
}

export interface TransformedSegment extends ClassifiedSegment {
	transformedText: string;
}

/**
 * Parse timestamp string (e.g., "1.100s") to seconds as a float
 */
export function parseTimestamp(offset: string): number {
	// Remove 's' suffix if present
	const cleaned = offset.replace(/s$/, '');
	return parseFloat(cleaned) || 0;
}

/**
 * Group words into speaker segments based on speaker tags
 */
export function groupWordsBySpeaker(words: WordInfo[]): SpeakerSegment[] {
	if (words.length === 0) {
		return [];
	}

	const segments: SpeakerSegment[] = [];
	let currentSegment: SpeakerSegment | null = null;

	for (const wordInfo of words) {
		const startTime = parseTimestamp(wordInfo.startOffset);
		const endTime = parseTimestamp(wordInfo.endOffset);

		// Start new segment if speaker changed or no current segment
		if (!currentSegment || currentSegment.speakerTag !== wordInfo.speakerTag) {
			// Save previous segment if exists
			if (currentSegment) {
				segments.push(currentSegment);
			}

			// Create new segment
			currentSegment = {
				speakerTag: wordInfo.speakerTag,
				text: wordInfo.word,
				startTime: startTime,
				endTime: endTime
			};
		} else {
			// Continue current segment
			currentSegment.text += ' ' + wordInfo.word;
			currentSegment.endTime = endTime; // Update end time to latest word
		}
	}

	// Don't forget the last segment
	if (currentSegment) {
		segments.push(currentSegment);
	}

	return segments;
}

/**
 * Find the context snapshot with the closest timestamp to the given time
 * Prefers contexts matching the current file if provided
 */
export function findNearestContext(
	timestamp: number,
	contexts: RecordingContext[],
	currentFile?: string
): RecordingContext | null {
	if (contexts.length === 0) {
		return null;
	}

	// Filter contexts matching current file if provided
	let candidates = contexts;
	if (currentFile) {
		const matchingFile = contexts.filter(ctx => ctx.file === currentFile);
		if (matchingFile.length > 0) {
			candidates = matchingFile;
		} else {
			// Log warning but use all contexts
			console.warn(`No context snapshots found for file ${currentFile}, using any available context`);
		}
	}

	// Find context with minimum absolute time difference
	let nearest: RecordingContext = candidates[0];
	let minDiff = Math.abs(candidates[0].timestamp - timestamp);

	for (const context of candidates) {
		const diff = Math.abs(context.timestamp - timestamp);
		if (diff < minDiff) {
			minDiff = diff;
			nearest = context;
		}
	}

	return nearest;
}

/**
 * Find the top N nearest contexts by timestamp
 * Prefers contexts matching the current file if provided
 */
export function findNearestContexts(
	timestamp: number,
	contexts: RecordingContext[],
	n: number = 5,
	currentFile?: string
): RecordingContext[] {
	if (contexts.length === 0) {
		return [];
	}

	// Filter contexts matching current file if provided
	let candidates = contexts;
	if (currentFile) {
		const matchingFile = contexts.filter(ctx => ctx.file === currentFile);
		if (matchingFile.length > 0) {
			candidates = matchingFile;
		} else {
			// Log warning but use all contexts
			console.warn(`No context snapshots found for file ${currentFile}, using any available context`);
		}
	}

	// Sort by absolute time difference
	const sorted = [...candidates].sort((a, b) => {
		const diffA = Math.abs(a.timestamp - timestamp);
		const diffB = Math.abs(b.timestamp - timestamp);
		return diffA - diffB;
	});

	// Return top N
	return sorted.slice(0, Math.min(n, sorted.length));
}

/**
 * Extract code context around visible symbols from a document
 * Returns formatted code snippet with line numbers
 */
export async function extractCodeContext(
	context: RecordingContext,
	document: vscode.TextDocument
): Promise<string> {
	const lineCount = document.lineCount;
	const codeSnippets: string[] = [];

	// Helper to find symbol by name recursively
	const findSymbolByName = (
		symbols: vscode.DocumentSymbol[],
		name: string
	): vscode.DocumentSymbol | null => {
		for (const symbol of symbols) {
			if (symbol.name === name) {
				return symbol;
			}
			if (symbol.children && symbol.children.length > 0) {
				const found = findSymbolByName(symbol.children, name);
				if (found) {
					return found;
				}
			}
		}
		return null;
	};

	// Try to extract code around visible symbols
	if (context.symbolsInView && context.symbolsInView.length > 0) {
		try {
			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				document.uri
			);

			if (symbols && Array.isArray(symbols)) {
				const PADDING = 2; // Lines of context around symbol
				
				for (const symbolName of context.symbolsInView) {
					const symbol = findSymbolByName(symbols, symbolName);
					if (symbol) {
						const startLine = Math.max(0, symbol.range.start.line - PADDING);
						const endLine = Math.min(lineCount - 1, symbol.range.end.line + PADDING);
						
						// Extract code lines
						const lines: string[] = [];
						for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
							const line = document.lineAt(lineNum);
							lines.push(`${lineNum + 1}: ${line.text}`);
						}
						
						if (lines.length > 0) {
							codeSnippets.push(`Symbol: ${symbolName}\n${lines.join('\n')}`);
						}
					}
				}
			}
		} catch (error) {
			console.warn('Failed to query document symbols for code extraction:', error);
		}
	}

	// Fallback: extract code around cursor line if no symbols found
	if (codeSnippets.length === 0 && context.cursorLine >= 0 && context.cursorLine < lineCount) {
		const PADDING = 10; // Lines of context around cursor
		const startLine = Math.max(0, context.cursorLine - PADDING);
		const endLine = Math.min(lineCount - 1, context.cursorLine + PADDING);
		
		const lines: string[] = [];
		for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
			const line = document.lineAt(lineNum);
			lines.push(`${lineNum + 1}: ${line.text}`);
		}
		
		if (lines.length > 0) {
			codeSnippets.push(`Cursor context (line ${context.cursorLine + 1}):\n${lines.join('\n')}`);
		}
	}

	// If still no code, return visible range
	if (codeSnippets.length === 0 && context.visibleRange[0] >= 0 && context.visibleRange[1] < lineCount) {
		const startLine = context.visibleRange[0];
		const endLine = Math.min(lineCount - 1, context.visibleRange[1]);
		
		const lines: string[] = [];
		for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
			const line = document.lineAt(lineNum);
			lines.push(`${lineNum + 1}: ${line.text}`);
		}
		
		if (lines.length > 0) {
			codeSnippets.push(`Visible range:\n${lines.join('\n')}`);
		}
	}

	return codeSnippets.join('\n\n') || '(No code context available)';
}

/**
 * Find the best location for a comment using heuristics
 * Uses nearest context's cursor line or falls back to file-level
 */
export async function findCommentLocation(
	segment: TransformedSegment,
	contexts: RecordingContext[],
	document: vscode.TextDocument,
	currentFile: string
): Promise<vscode.Range> {
	const lineCount = document.lineCount;

	// Get nearest context
	const candidateContexts = findNearestContexts(segment.startTime, contexts, 1, currentFile);

	if (candidateContexts.length === 0) {
		// Fallback: use file-level
		const firstLine = document.lineAt(0);
		return new vscode.Range(0, 0, 0, firstLine.text.length);
	}

	const fallbackContext = candidateContexts[0];
	
	// 1. Try cursor line
	if (fallbackContext.cursorLine >= 0 && fallbackContext.cursorLine < lineCount) {
		const line = document.lineAt(fallbackContext.cursorLine);
		return new vscode.Range(
			fallbackContext.cursorLine,
			0,
			fallbackContext.cursorLine,
			line.text.length
		);
	}

	// 2. Try visible symbols
	if (fallbackContext.symbolsInView && fallbackContext.symbolsInView.length > 0) {
		try {
			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				document.uri
			);

			if (symbols && Array.isArray(symbols)) {
				const findSymbolByName = (
					symbols: vscode.DocumentSymbol[],
					name: string
				): vscode.DocumentSymbol | null => {
					for (const symbol of symbols) {
						if (symbol.name === name) {
							return symbol;
						}
						if (symbol.children && symbol.children.length > 0) {
							const found = findSymbolByName(symbol.children, name);
							if (found) {
								return found;
							}
						}
					}
					return null;
				};

				for (const symbolName of fallbackContext.symbolsInView) {
					const symbol = findSymbolByName(symbols, symbolName);
					if (symbol) {
						const line = document.lineAt(symbol.range.start.line);
						return new vscode.Range(
							symbol.range.start.line,
							0,
							symbol.range.start.line,
							line.text.length
						);
					}
				}
			}
		} catch (error) {
			console.warn('Failed to query document symbols for comment placement:', error);
		}
	}

	// 3. File-level fallback (line 0)
	const firstLine = document.lineAt(0);
	return new vscode.Range(0, 0, 0, firstLine.text.length);
}

/**
 * Find the best locations for multiple comments using Gemini API
 * Returns an array of ranges corresponding to each segment
 */
export async function findCommentLocationsBatch(
	segments: TransformedSegment[],
	contexts: RecordingContext[],
	document: vscode.TextDocument,
	currentFile: string
): Promise<vscode.Range[]> {
	const lineCount = document.lineCount;

	// Extract candidate contexts for all segments
	const allCandidateContexts = segments.map(segment => 
		findNearestContexts(segment.startTime, contexts, 5, currentFile)
	);

	// Extract code context for all candidates in parallel
	const allCandidates: CandidateLocation[][] = await Promise.all(
		allCandidateContexts.map(async (candidateContexts) => {
			if (candidateContexts.length === 0) {
				return [];
			}
			return Promise.all(
				candidateContexts.map(async (context) => {
					const codeContext = await extractCodeContext(context, document);
					return {
						timestamp: context.timestamp,
						file: context.file,
						cursorLine: context.cursorLine,
						visibleRange: context.visibleRange as [number, number],
						symbolsInView: context.symbolsInView,
						codeContext: codeContext
					};
				})
			);
		})
	);

	// Prepare batch request
	const batchSegments = segments.map(segment => ({
		commentText: segment.transformedText,
		classification: segment.classification,
		timestamp: segment.startTime,
		fileName: currentFile
	}));

	// Call local Gemini service directly
	try {
		const locations = await selectCommentLocationsBatch(batchSegments, allCandidates);
		
		if (locations.length !== segments.length) {
			throw new Error(`Invalid response: expected ${segments.length} locations, got ${locations.length}`);
		}

		// Convert selected indices to ranges
		const ranges: vscode.Range[] = [];
		for (let i = 0; i < segments.length; i++) {
			const location = locations[i];
			const candidateContexts = allCandidateContexts[i];
			const selectedCandidate = candidateContexts[location.selectedIndex];

			if (!selectedCandidate) {
				// Fallback to file-level
				const firstLine = document.lineAt(0);
				ranges.push(new vscode.Range(0, 0, 0, firstLine.text.length));
				continue;
			}

			// Convert to range - prefer cursor line, then visible symbols, then visible range
			if (selectedCandidate.cursorLine >= 0 && selectedCandidate.cursorLine < lineCount) {
				const line = document.lineAt(selectedCandidate.cursorLine);
				ranges.push(new vscode.Range(
					selectedCandidate.cursorLine,
					0,
					selectedCandidate.cursorLine,
					line.text.length
				));
				continue;
			}

			// Try visible symbols
			if (selectedCandidate.symbolsInView && selectedCandidate.symbolsInView.length > 0) {
				try {
					const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
						'vscode.executeDocumentSymbolProvider',
						document.uri
					);

					if (symbols && Array.isArray(symbols)) {
						const findSymbolByName = (
							symbols: vscode.DocumentSymbol[],
							name: string
						): vscode.DocumentSymbol | null => {
							for (const symbol of symbols) {
								if (symbol.name === name) {
									return symbol;
								}
								if (symbol.children && symbol.children.length > 0) {
									const found = findSymbolByName(symbol.children, name);
									if (found) {
										return found;
									}
								}
							}
							return null;
						};

						for (const symbolName of selectedCandidate.symbolsInView) {
							const symbol = findSymbolByName(symbols, symbolName);
							if (symbol) {
								const line = document.lineAt(symbol.range.start.line);
								ranges.push(new vscode.Range(
									symbol.range.start.line,
									0,
									symbol.range.start.line,
									line.text.length
								));
								break;
							}
						}
						if (ranges.length === i + 1) {
							continue; // Found a symbol, move to next segment
						}
					}
				} catch (error) {
					console.warn('Failed to query document symbols for comment placement:', error);
				}
			}

			// Fallback to visible range start
			if (selectedCandidate.visibleRange[0] >= 0 && selectedCandidate.visibleRange[0] < lineCount) {
				const line = document.lineAt(selectedCandidate.visibleRange[0]);
				ranges.push(new vscode.Range(
					selectedCandidate.visibleRange[0],
					0,
					selectedCandidate.visibleRange[0],
					line.text.length
				));
				continue;
			}

			// Final fallback: file-level
			const firstLine = document.lineAt(0);
			ranges.push(new vscode.Range(0, 0, 0, firstLine.text.length));
		}

		return ranges;
	} catch (error) {
		console.warn('Failed to use Gemini for location selection, falling back to simple location:', error);
		// Fallback: use cursor line from nearest context
		const ranges: vscode.Range[] = [];
		for (const segment of segments) {
			const nearestContexts = findNearestContexts(segment.startTime, contexts, 1, currentFile);
			if (nearestContexts.length > 0 && nearestContexts[0].cursorLine >= 0 && nearestContexts[0].cursorLine < lineCount) {
				const line = document.lineAt(nearestContexts[0].cursorLine);
				ranges.push(new vscode.Range(nearestContexts[0].cursorLine, 0, nearestContexts[0].cursorLine, line.text.length));
			} else {
				const firstLine = document.lineAt(0);
				ranges.push(new vscode.Range(0, 0, 0, firstLine.text.length));
			}
		}
		return ranges;
	}
}

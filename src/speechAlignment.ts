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
 * Find a symbol by name recursively in a symbol hierarchy
 */
function findSymbolByName(
	symbols: vscode.DocumentSymbol[],
	name: string
): vscode.DocumentSymbol | null {
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
}

/**
 * Create a range for a specific line in a document
 */
function createLineRange(document: vscode.TextDocument, lineNumber: number): vscode.Range {
	const line = document.lineAt(lineNumber);
	return new vscode.Range(lineNumber, 0, lineNumber, line.text.length);
}

/**
 * Create a fallback range at the start of the document
 */
function createFileLevelFallbackRange(document: vscode.TextDocument): vscode.Range {
	const firstLine = document.lineAt(0);
	return new vscode.Range(0, 0, 0, firstLine.text.length);
}

/**
 * Filter contexts by file, with fallback to all contexts if no matches
 */
function filterContextsByFile(contexts: RecordingContext[], currentFile?: string): RecordingContext[] {
	if (!currentFile) {
		return contexts;
	}
	const matchingFile = contexts.filter(ctx => ctx.file === currentFile);
	if (matchingFile.length > 0) {
		return matchingFile;
	}
	console.warn(`No context snapshots found for file ${currentFile}, using any available context`);
	return contexts;
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

	const candidates = filterContextsByFile(contexts, currentFile);

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
				ranges.push(createFileLevelFallbackRange(document));
				continue;
			}

			// Convert to range - prefer cursor line, then visible symbols, then visible range
			if (selectedCandidate.cursorLine >= 0 && selectedCandidate.cursorLine < lineCount) {
				ranges.push(createLineRange(document, selectedCandidate.cursorLine));
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
						let foundSymbol = false;
						for (const symbolName of selectedCandidate.symbolsInView) {
							const symbol = findSymbolByName(symbols, symbolName);
							if (symbol) {
								ranges.push(createLineRange(document, symbol.range.start.line));
								foundSymbol = true;
								break;
							}
						}
						if (foundSymbol) {
							continue;
						}
					}
				} catch (error) {
					console.warn('Failed to query document symbols for comment placement:', error);
				}
			}

			// Fallback to visible range start
			if (selectedCandidate.visibleRange[0] >= 0 && selectedCandidate.visibleRange[0] < lineCount) {
				ranges.push(createLineRange(document, selectedCandidate.visibleRange[0]));
				continue;
			}

			// Final fallback: file-level
			ranges.push(createFileLevelFallbackRange(document));
		}

		return ranges;
	} catch (error) {
		console.warn('Failed to use Gemini for location selection, falling back to simple location:', error);
		// Fallback: use cursor line from nearest context
		const ranges: vscode.Range[] = [];
		for (const segment of segments) {
			const nearestContexts = findNearestContexts(segment.startTime, contexts, 1, currentFile);
			if (nearestContexts.length > 0 && nearestContexts[0].cursorLine >= 0 && nearestContexts[0].cursorLine < lineCount) {
				ranges.push(createLineRange(document, nearestContexts[0].cursorLine));
			} else {
				ranges.push(createFileLevelFallbackRange(document));
			}
		}
		return ranges;
	}
}

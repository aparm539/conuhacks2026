import * as vscode from 'vscode';
import { RecordingContext } from './contextCollector';
import { SpeakerSegment, ClassifiedSegment, TransformedSegment, SegmentClassification } from './types';
import { CONTEXT_MATCH_PADDING_LINES, CODE_SNIPPET_PADDING_LINES, MAX_CANDIDATES_PER_SEGMENT } from './config/constants';

export interface WordInfo {
	word: string;
	speakerTag: number;
	startOffset: string;
	endOffset: string;
}

/**
 * Parse timestamp string (e.g., "1.100s") to seconds as a float
 */
function parseTimestamp(offset: string): number {
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
 * Find a symbol by name recursively in a document symbol tree
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
 * Create a range from a line number (full line)
 */
function createRangeFromLine(document: vscode.TextDocument, line: number): vscode.Range {
	const lineText = document.lineAt(line);
	return new vscode.Range(line, 0, line, lineText.text.length);
}

/**
 * Create a range from a symbol's start line
 */
function createRangeFromSymbol(symbol: vscode.DocumentSymbol, document: vscode.TextDocument): vscode.Range {
	const line = document.lineAt(symbol.range.start.line);
	return new vscode.Range(
		symbol.range.start.line,
		0,
		symbol.range.start.line,
		line.text.length
	);
}

/**
 * Create a range from visible range start line
 */
function createRangeFromVisibleRange(document: vscode.TextDocument, visibleRange: [number, number]): vscode.Range | null {
	const lineCount = document.lineCount;
	if (visibleRange[0] >= 0 && visibleRange[0] < lineCount) {
		return createRangeFromLine(document, visibleRange[0]);
	}
	return null;
}

/**
 * Convert a candidate context to a range using fallback chain:
 * 1. Cursor line
 * 2. Visible symbols
 * 3. Visible range start
 * 4. File-level (line 0)
 */
async function convertCandidateToRange(
	candidate: RecordingContext,
	document: vscode.TextDocument
): Promise<vscode.Range> {
	const lineCount = document.lineCount;

	// 1. Try cursor line
	if (candidate.cursorLine >= 0 && candidate.cursorLine < lineCount) {
		return createRangeFromLine(document, candidate.cursorLine);
	}

	// 2. Try visible symbols
	if (candidate.symbolsInView && candidate.symbolsInView.length > 0) {
		try {
			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				document.uri
			);

			if (symbols && Array.isArray(symbols)) {
				for (const symbolName of candidate.symbolsInView) {
					const symbol = findSymbolByName(symbols, symbolName);
					if (symbol) {
						return createRangeFromSymbol(symbol, document);
					}
				}
			}
		} catch (error) {
			console.warn('Failed to query document symbols for comment placement:', error);
		}
	}

	// 3. Try visible range start
	const visibleRange = createRangeFromVisibleRange(document, candidate.visibleRange);
	if (visibleRange) {
		return visibleRange;
	}

	// 4. File-level fallback (line 0)
	return createRangeFromLine(document, 0);
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
				for (const symbolName of context.symbolsInView) {
					const symbol = findSymbolByName(symbols, symbolName);
					if (symbol) {
						const startLine = Math.max(0, symbol.range.start.line - CONTEXT_MATCH_PADDING_LINES);
						const endLine = Math.min(lineCount - 1, symbol.range.end.line + CONTEXT_MATCH_PADDING_LINES);
						
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
 * Find the best locations for multiple comments using batch API
 * Returns an array of ranges corresponding to each segment
 */
export async function findCommentLocationsBatch(
	segments: TransformedSegment[],
	contexts: RecordingContext[],
	document: vscode.TextDocument,
	currentFile: string,
	serverUrl: string = 'http://localhost:3000'
): Promise<vscode.Range[]> {
	const lineCount = document.lineCount;

	// Extract candidate contexts for all segments
	const allCandidateContexts = segments.map(segment => 
		findNearestContexts(segment.startTime, contexts, MAX_CANDIDATES_PER_SEGMENT, currentFile)
	);

	// Extract code context for all candidates in parallel
	const allCandidates = await Promise.all(
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
						visibleRange: context.visibleRange,
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

	// Call batch API
	try {
		const response = await fetch(`${serverUrl}/select-comment-locations`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				segments: batchSegments,
				candidates: allCandidates,
			}),
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const data = await response.json() as { locations: Array<{ selectedIndex: number; rationale?: string }> };
		
		if (!data.locations || !Array.isArray(data.locations) || data.locations.length !== segments.length) {
			throw new Error(`Invalid response: expected ${segments.length} locations, got ${data.locations?.length || 0}`);
		}

		// Convert selected indices to ranges
		const ranges: vscode.Range[] = [];
		for (let i = 0; i < segments.length; i++) {
			const location = data.locations[i];
			const candidateContexts = allCandidateContexts[i];
			const selectedCandidate = candidateContexts[location.selectedIndex];

			if (!selectedCandidate) {
				// Fallback to file-level
				ranges.push(createRangeFromLine(document, 0));
			} else {
				ranges.push(await convertCandidateToRange(selectedCandidate, document));
			}
		}

		return ranges;
	} catch (error) {
		console.warn('Failed to select comment locations:', error);
		return []
	}
}

export { TransformedSegment };

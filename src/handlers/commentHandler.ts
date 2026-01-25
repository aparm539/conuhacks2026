import * as vscode from 'vscode';
import { TransformedSegment } from '../speechAlignment';
import { RecordingContext } from '../contextCollector';
import { getFileRelativePath } from '../utils/vscode';
import { findCommentLocationsBatch } from '../speechAlignment';
import { TRANSCRIPTION_SERVER_URL } from '../config/constants';

/**
 * Create comments for transformed segments
 */
export async function createComments(
	transformedSegments: TransformedSegment[],
	contexts: RecordingContext[],
	commentController: vscode.CommentController
): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('No active editor found. Please open a file to add comments.');
		return;
	}

	const document = editor.document;
	
	// Get current file path for context matching
	const currentFile = getFileRelativePath(document);

	// Filter out Ignore segments (safety check - server already filters them)
	const segmentsToComment = transformedSegments.filter(seg => seg.classification !== 'Ignore');
	
	console.log(`[EXTENSION] Filtered ${transformedSegments.length} transformed segments, ${segmentsToComment.length} non-Ignore segments remain`);

	if (segmentsToComment.length === 0) {
		const ignoreCount = transformedSegments.filter(seg => seg.classification === 'Ignore').length;
		vscode.window.showWarningMessage(
			`No speech segments found to create comments. ${transformedSegments.length} segments were processed, but ${ignoreCount} were classified as 'Ignore' and filtered out.`
		);
		return;
	}

	// Find all comment locations in parallel using batch API
	const ranges = await findCommentLocationsBatch(
		segmentsToComment,
		contexts,
		document,
		currentFile || '',
		TRANSCRIPTION_SERVER_URL
	);

	// Create comments for all segments (display incrementally as they're created)
	for (let i = 0; i < segmentsToComment.length; i++) {
		const segment = segmentsToComment[i];
		const range = ranges[i];

		// Format comment text with speaker label using transformed text
		const commentText = `**Speaker ${segment.speakerTag}:** ${segment.transformedText}`;

		// Create comment
		const comment: vscode.Comment = {
			body: new vscode.MarkdownString(commentText),
			mode: vscode.CommentMode.Preview,
			author: { name: 'PR Notes' }
		};

		// Create comment thread at the determined location
		commentController.createCommentThread(document.uri, range, [comment]);
	}

	// Show completion message
	vscode.window.showInformationMessage(`Created ${segmentsToComment.length} comment(s) in ${currentFile}`);
}

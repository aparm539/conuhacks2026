import * as vscode from 'vscode';
import { WordInfo, SpeakerSegment, ClassifiedSegment, TransformedSegment, groupWordsBySpeaker } from '../speechAlignment';
import { RecordingContext } from '../contextCollector';
import { HttpClient } from './httpClient';
import { TRANSCRIPTION_SERVER_URL } from '../config/constants';

const transcriptionClient = new HttpClient(TRANSCRIPTION_SERVER_URL);

/**
 * Transcribe audio data to words
 */
export async function transcribeAudio(audioData: Buffer, audioFilePath: string): Promise<WordInfo[]> {
	const audioBase64 = audioData.toString('base64');
	const data = await transcriptionClient.post<{ audio: string }, { words?: WordInfo[] }>(
		'/transcribe',
		{ audio: audioBase64 },
		{ errorContext: 'Transcription' }
	);
	
	if (!data.words || !Array.isArray(data.words)) {
		throw new Error('No words array in response');
	}

	return data.words;
}

/**
 * Process segments through unified pipeline (classify, split, transform)
 * This replaces the previous 3-step process with a single API call
 */
export async function processSegments(segments: SpeakerSegment[]): Promise<TransformedSegment[]> {
	const data = await transcriptionClient.post<{ segments: SpeakerSegment[] }, { transformedSegments?: TransformedSegment[] }>(
		'/process-segments',
		{ segments },
		{ errorContext: 'Unified Processing' }
	);
	
	if (!data.transformedSegments || !Array.isArray(data.transformedSegments)) {
		throw new Error('No transformedSegments array in response');
	}

	return data.transformedSegments;
}

/**
 * Classify segments into categories
 * @deprecated Use processSegments() instead for unified processing
 */
export async function classifySegments(segments: SpeakerSegment[]): Promise<ClassifiedSegment[]> {
	const data = await transcriptionClient.post<{ segments: SpeakerSegment[] }, { classifiedSegments?: ClassifiedSegment[] }>(
		'/classify',
		{ segments },
		{ errorContext: 'Classification' }
	);
	
	if (!data.classifiedSegments || !Array.isArray(data.classifiedSegments)) {
		throw new Error('No classifiedSegments array in response');
	}

	return data.classifiedSegments;
}

/**
 * Transform segments into comment text
 * @deprecated Use processSegments() instead for unified processing
 */
export async function transformSegments(classifiedSegments: ClassifiedSegment[]): Promise<TransformedSegment[]> {
	const data = await transcriptionClient.post<{ classifiedSegments: ClassifiedSegment[] }, { transformedSegments?: TransformedSegment[] }>(
		'/transform',
		{ classifiedSegments },
		{ errorContext: 'Transformation' }
	);
	
	if (!data.transformedSegments || !Array.isArray(data.transformedSegments)) {
		throw new Error('No transformedSegments array in response');
	}

	return data.transformedSegments;
}

/**
 * Split segments based on topic and context
 * @deprecated Use processSegments() instead for unified processing
 */
export async function splitSegments(classifiedSegments: ClassifiedSegment[]): Promise<ClassifiedSegment[]> {
	const data = await transcriptionClient.post<{ classifiedSegments: ClassifiedSegment[] }, { splitSegments?: ClassifiedSegment[] }>(
		'/split',
		{ classifiedSegments },
		{ errorContext: 'Splitting' }
	);
	
	if (!data.splitSegments || !Array.isArray(data.splitSegments)) {
		throw new Error('No splitSegments array in response');
	}

	return data.splitSegments;
}

/**
 * Process audio through the full pipeline: grouping, classification, splitting, transformation
 */
export async function processAudioPipeline(
	words: WordInfo[],
	contexts: RecordingContext[]
): Promise<TransformedSegment[]> {
	return await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "Processing Audio",
		cancellable: false
	}, async (progress) => {
		// Group words by speaker segments
		progress.report({ increment: 0, message: "Grouping words into segments..." });
		const segments = groupWordsBySpeaker(words);
		console.log(`[EXTENSION] Grouped ${words.length} words into ${segments.length} segments`);
		
		if (segments.length === 0) {
			vscode.window.showWarningMessage('No speech segments found after grouping words. This might indicate an issue with the transcription.');
			throw new Error('No segments found');
		}
		
		// Process segments through unified pipeline (classify, split, transform in one call)
		progress.report({ increment: 20, message: `Processing ${segments.length} segments...` });
		const transformedSegments = await processSegments(segments);
		console.log(`[EXTENSION] Processed ${segments.length} segments into ${transformedSegments.length} transformed segments`);
		
		// Log classification breakdown
		const classificationCounts = transformedSegments.reduce((acc, seg) => {
			acc[seg.classification] = (acc[seg.classification] || 0) + 1;
			return acc;
		}, {} as Record<string, number>);
		console.log(`[EXTENSION] Classification breakdown:`, classificationCounts);
		
		progress.report({ increment: 60, message: "Complete!" });
		return transformedSegments;
	});
}

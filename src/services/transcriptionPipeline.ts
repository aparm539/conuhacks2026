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
 * Classify segments into categories
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
		
		// Classify segments
		progress.report({ increment: 20, message: `Classifying ${segments.length} segments...` });
		const classifiedSegments = await classifySegments(segments);
		console.log(`[EXTENSION] Classified ${segments.length} segments into ${classifiedSegments.length} classified segments`);
		
		// Split segments based on topic and context
		progress.report({ increment: 20, message: `Splitting ${classifiedSegments.length} segments...` });
		const splitClassifiedSegments = await splitSegments(classifiedSegments);
		console.log(`[EXTENSION] Split ${classifiedSegments.length} segments into ${splitClassifiedSegments.length} split segments`);
		
		// Transform segments
		progress.report({ increment: 20, message: `Transforming ${splitClassifiedSegments.length} segments...` });
		const transformedSegments = await transformSegments(splitClassifiedSegments);
		console.log(`[EXTENSION] Transformed ${splitClassifiedSegments.length} segments into ${transformedSegments.length} transformed segments`);
		
		// Log classification breakdown
		const classificationCounts = transformedSegments.reduce((acc, seg) => {
			acc[seg.classification] = (acc[seg.classification] || 0) + 1;
			return acc;
		}, {} as Record<string, number>);
		console.log(`[EXTENSION] Classification breakdown:`, classificationCounts);
		
		progress.report({ increment: 20, message: "Complete!" });
		return transformedSegments;
	});
}

import * as vscode from 'vscode';
import { WordInfo, groupWordsBySpeaker } from '../speechAlignment';
import { SpeakerSegment, TransformedSegment } from '../types';
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
async function processSegments(segments: SpeakerSegment[]): Promise<TransformedSegment[]> {
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
 * Process audio through the full pipeline: grouping, classification, splitting, transformation
 */
export async function processAudioPipeline(
	words: WordInfo[],
	contexts: RecordingContext[]
): Promise<TransformedSegment[]> {
	// Group words by speaker segments
	const segments = groupWordsBySpeaker(words);
	
	if (segments.length === 0) {
		vscode.window.showWarningMessage('No speech segments found after grouping words. This might indicate an issue with the transcription.');
		throw new Error('No segments found');
	}
	
	// Process segments through unified pipeline (classify, split, transform in one call)
	const transformedSegments = await processSegments(segments);
	
	return transformedSegments;
}

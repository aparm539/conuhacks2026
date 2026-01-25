import * as vscode from 'vscode';
import { WordInfo } from '../speechAlignment';
import { RecordingContext } from '../contextCollector';
import { transcribeAudio, processAudioPipeline } from '../services/transcriptionPipeline';
import { createComments } from './commentHandler';
export interface AudioMessageHandlerConfig {
	commentController: vscode.CommentController;
}

/**
 * Save recording files (audio and context)
 */
async function saveRecordingFiles(
	audioData: Buffer,
	fileName: string,
	contexts: RecordingContext[] | null,
	recordingsUri: vscode.Uri
): Promise<Promise<void>[]> {
	const fileUri = vscode.Uri.joinPath(recordingsUri, fileName);
	const fileWritePromises: Promise<void>[] = [
		new Promise<void>((resolve, reject) => {
			vscode.workspace.fs.writeFile(fileUri, audioData).then(() => {
				vscode.window.showInformationMessage(`Recording saved: ${fileName}`);
				resolve();
			}, reject);
		})
	];

	if (contexts && contexts.length > 0) {
		const contextFileName = fileName.replace('.wav', '.context.json');
		const contextUri = vscode.Uri.joinPath(recordingsUri, contextFileName);
		const contextJson = JSON.stringify(contexts, null, 2);
		const contextBuffer = Buffer.from(contextJson, 'utf8');
		fileWritePromises.push(
			new Promise<void>((resolve, reject) => {
				vscode.workspace.fs.writeFile(contextUri, contextBuffer).then(() => {
					console.log(`Context saved: ${contextFileName}`);
					resolve();
				}, reject);
			})
		);
	}

	return fileWritePromises;
}

/**
 * Format and save transcript
 */
async function formatAndSaveTranscript(
	words: WordInfo[],
	fileName: string,
	recordingsUri: vscode.Uri,
	fileWritePromises: Promise<void>[]
): Promise<void> {
	// Format transcript for saving (with speaker labels)
	let formattedTranscript = '';
	let currentSpeaker = -1;
	for (const wordInfo of words) {
		if (currentSpeaker !== wordInfo.speakerTag) {
			if (formattedTranscript) {
				formattedTranscript += '\n\n';
			}
			formattedTranscript += `**Speaker ${wordInfo.speakerTag}:** `;
			currentSpeaker = wordInfo.speakerTag;
		}
		formattedTranscript += wordInfo.word + ' ';
	}
	
	// Save transcript as .txt file
	const transcriptFileName = fileName.replace('.wav', '.txt');
	const transcriptUri = vscode.Uri.joinPath(recordingsUri, transcriptFileName);
	const transcriptBuffer = Buffer.from(formattedTranscript.trim(), 'utf8');
	fileWritePromises.push(
		new Promise<void>((resolve, reject) => {
			vscode.workspace.fs.writeFile(transcriptUri, transcriptBuffer).then(() => {
				vscode.window.showInformationMessage(`Transcript saved: ${transcriptFileName}`);
				resolve();
			}, reject);
		})
	);
}

/**
 * Handle audio message from server
 */
export async function handleAudioMessage(
	audioData: Buffer,
	contexts: RecordingContext[] | null,
	globalStorageUri: vscode.Uri,
	config: AudioMessageHandlerConfig,
	onComplete: () => void
): Promise<void> {
	const recordingsUri = vscode.Uri.joinPath(globalStorageUri, 'recordings');
	
	// Create directory 
	await vscode.workspace.fs.createDirectory(recordingsUri);

	console.log(recordingsUri); 
	
	// Prepare file names and data
	const fileName = `${Date.now()}.wav`;

	// Prepare file writes (don't await yet - start transcription immediately)
	const fileWritePromises = await saveRecordingFiles(audioData, fileName, contexts, recordingsUri);
	
	// Start file writes in parallel (don't await yet - start transcription immediately)
	Promise.all(fileWritePromises).catch(err => {
		console.error('Error saving files:', err);
	});
	
	// Transcribe the audio (start immediately, don't wait for file writes)
	try {
		const words = await transcribeAudio(audioData, fileName);
		
		// Format and save transcript
		await formatAndSaveTranscript(words, fileName, recordingsUri, fileWritePromises);

		// Wait for all file writes to complete (including transcript)
		await Promise.all(fileWritePromises);
		
		// Process audio pipeline
		const transformedSegments = await processAudioPipeline(words, contexts || []);
		
		// Create comments aligned to code using context snapshots with transformed text
		await createComments(transformedSegments, contexts || [], config.commentController);
	} catch (error) {
		console.error('Transcription failed:', error);
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		vscode.window.showErrorMessage(`Failed to process audio: ${errorMessage}`);
	} finally {
		onComplete();
	}
}

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import { AudioService } from './audioService';
import { DiarizationApiClient } from './apiClient';
import { createStatusBarItem, updateStatusBar, showStatusBarMenu, StatusBarCallbacks } from './statusBar';
import { ServerManager } from './services/serverManager';
import { RecordingService } from './services/recordingService';
import { handleAudioMessage } from './handlers/audioMessageHandler';

let audioService: AudioService;

export function activate(context: vscode.ExtensionContext) {

	// Initialize audio service for diarisation
	const apiClient = new DiarizationApiClient();
	audioService = new AudioService(context, apiClient);

	// Recording functionality setup
	const serverManager = new ServerManager(context.extensionPath);
	const recordingService = new RecordingService(serverManager);

	const commentController = vscode.comments.createCommentController('pr-notes-comments', 'PR Notes');

	// Create status bar item 
	const statusBarItem = createStatusBarItem();
	statusBarItem.command = "pr-notes.showMenu";

	function refreshStatusBar() {
		updateStatusBar(statusBarItem, recordingService.getIsRecording());
	}

	// Initial status bar update
	refreshStatusBar();

	// Setup server manager callbacks
	serverManager.start({
		onClose: () => {
			recordingService.setIsRecording(false);
			recordingService.clearContext();
			refreshStatusBar();
		},
		onError: () => {
			recordingService.setIsRecording(false);
			recordingService.clearContext();
			refreshStatusBar();
		},
		onMessage: async (message: { type: string; data: string }) => {
			console.log("We have a message");
			if (message.type === 'audio') {
				const audioData = Buffer.from(message.data, 'base64');
				const contextsToUse = recordingService.getPendingContext();
				
				await handleAudioMessage(
					audioData,
					contextsToUse,
					context.globalStorageUri,
					{ commentController },
					() => {
						recordingService.setIsRecording(false);
						refreshStatusBar();
					}
				);
			}
		}
	});

	function handleStartRecording() {
		recordingService.startRecording();
		refreshStatusBar();
	}

	function handleStopRecording() {
		recordingService.stopRecording();
	}

	// Register command for processing audio file (diarisation)
	const processAudioDisposable = vscode.commands.registerCommand('pr-notes.processAudio', async () => {
		try {
			const results = await audioService.processAudioFromFile();
			
			if (results) {
				// Show results in a new document
				const doc = await vscode.workspace.openTextDocument({
					content: audioService.formatResultsAsText(results),
					language: 'plaintext'
				});
				await vscode.window.showTextDocument(doc);
				
				// Also show summary notification
				vscode.window.showInformationMessage(
					`Processed audio: ${results.total_speakers} speakers, ${results.segments.length} segments`
				);
			}
		} catch (error) {
			if (error instanceof Error) {
				vscode.window.showErrorMessage(`Failed to process audio: ${error.message}`);
			}
		}
	});

	// Status bar menu command (recording)
	const showMenuDisposable = vscode.commands.registerCommand('pr-notes.showMenu', async () => {
		const callbacks: StatusBarCallbacks = {
			onStartRecording: handleStartRecording,
			onStopRecording: handleStopRecording
		};

		await showStatusBarMenu(recordingService.getIsRecording(), callbacks);
		refreshStatusBar();
	});

	context.subscriptions.push(statusBarItem);
	context.subscriptions.push(commentController);
	context.subscriptions.push(processAudioDisposable);
	context.subscriptions.push(showMenuDisposable);
}

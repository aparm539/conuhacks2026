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

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('PR Notes extension is now active!');

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

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const helloWorldDisposable = vscode.commands.registerCommand('pr-notes.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from pr-notes!');
	});

	context.subscriptions.push(statusBarItem);
	context.subscriptions.push(commentController);
	context.subscriptions.push(processAudioDisposable);
	context.subscriptions.push(showMenuDisposable);
	context.subscriptions.push(helloWorldDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
	// Cleanup if needed
}

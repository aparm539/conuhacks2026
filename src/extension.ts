// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { AudioService } from './audioService';
import { DiarizationApiClient } from './apiClient';

let audioService: AudioService;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('PR Notes extension is now active!');

	// Initialize audio service
	const apiClient = new DiarizationApiClient();
	audioService = new AudioService(context, apiClient);

	// Check service health on activation
	audioService.checkServiceHealth().then(isHealthy => {
		if (isHealthy) {
			console.log('Diarization service is ready');
		}
	});

	// Register command for processing audio file
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

	// Register command for checking service health
	const checkHealthDisposable = vscode.commands.registerCommand('pr-notes.checkHealth', async () => {
		const isHealthy = await audioService.checkServiceHealth();
		if (isHealthy) {
			vscode.window.showInformationMessage('Diarization service is healthy and ready!');
		} else {
			vscode.window.showWarningMessage('Diarization service is not available. Please check the Docker container.');
		}
	});

	// Keep the old hello world command for compatibility
	const helloWorldDisposable = vscode.commands.registerCommand('pr-notes.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from pr-notes!');
	});

	context.subscriptions.push(processAudioDisposable);
	context.subscriptions.push(checkHealthDisposable);
	context.subscriptions.push(helloWorldDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
	// Cleanup if needed
}

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import { AudioService } from './audioService';
import { DiarizationApiClient } from './apiClient';
import { createStatusBarItem, updateStatusBar, showStatusBarMenu, StatusBarCallbacks } from './statusBar';
import { ServerManager } from './services/serverManager';
import { RecordingService } from './services/recordingService';
import { handleAudioMessage } from './handlers/audioMessageHandler';
import { getSession, getAuthState, onSessionChange, registerSessionChangeListener } from './githubAuth';
import { getSelectedDevice, selectAudioDevice, listAudioDevices } from './audioDeviceManager';

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

	async function refreshStatusBar() {
		const selectedDeviceId = getSelectedDevice();
		let deviceDisplayName: string | undefined = undefined;

		if (selectedDeviceId && selectedDeviceId !== 'default') {
			// Look up device name from the device list
			const devices = await listAudioDevices();
			const device = devices.find(d => d.id === selectedDeviceId);
			deviceDisplayName = device?.name;
		}

		const authState = await getAuthState();
		updateStatusBar(statusBarItem, recordingService.getIsRecording(), deviceDisplayName, authState.accountLabel);
	}

	// Initial status bar update
	refreshStatusBar();

	// Auth: refresh status bar when GitHub sessions change (e.g. sign in/out from Accounts menu)
	context.subscriptions.push(registerSessionChangeListener());
	context.subscriptions.push(onSessionChange(() => {
		refreshStatusBar().catch(err => console.error('Error refreshing status bar:', err));
	}));

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

	async function handleSelectDevice(): Promise<void> {
		await selectAudioDevice();
		await refreshStatusBar();
	}

	async function handleLogin(): Promise<void> {
		try {
			const session = await getSession(true);
			await refreshStatusBar();
			if (session?.account.label) {
				vscode.window.showInformationMessage(`Signed in as ${session.account.label}`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Sign-in failed';
			vscode.window.showErrorMessage(`GitHub sign-in failed: ${msg}`);
		}
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
		const selectedDeviceId = getSelectedDevice();
		let deviceDisplayName: string | undefined = undefined;

		if (selectedDeviceId && selectedDeviceId !== 'default') {
			const devices = await listAudioDevices();
			const device = devices.find(d => d.id === selectedDeviceId);
			deviceDisplayName = device?.name;
		}

		const authState = await getAuthState();
		const callbacks: StatusBarCallbacks = {
			onStartRecording: handleStartRecording,
			onStopRecording: handleStopRecording,
			onSelectDevice: handleSelectDevice,
			onLogin: handleLogin
		};

		await showStatusBarMenu(recordingService.getIsRecording(), deviceDisplayName, callbacks, authState);
		await refreshStatusBar();
	});

	const loginDisposable = vscode.commands.registerCommand('pr-notes.login', handleLogin);

	context.subscriptions.push(statusBarItem);
	context.subscriptions.push(commentController);
	context.subscriptions.push(processAudioDisposable);
	context.subscriptions.push(showMenuDisposable);
	context.subscriptions.push(loginDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
	// Cleanup if needed
}

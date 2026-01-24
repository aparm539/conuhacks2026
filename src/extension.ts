import * as vscode from 'vscode';
import * as path from 'path';

import {spawn, ChildProcess} from 'child_process';
import { createStatusBarItem, updateStatusBar, showStatusBarMenu, StatusBarCallbacks } from './statusBar';
import { getSelectedDevice, selectAudioDevice, listAudioDevices } from './audioDeviceManager';
import { ContextCollector, RecordingContext } from './contextCollector';

const TRANSCRIPTION_SERVER_URL = 'http://localhost:3000';

export function activate(context: vscode.ExtensionContext) {

	const serverPath = path.join(context.extensionPath, 'out', 'server.js');

	let serverProcess: ChildProcess | null = null;
	let isRecording = false;
	const contextCollector = new ContextCollector();
	let pendingContext: RecordingContext[] | null = null;

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
		
		updateStatusBar(statusBarItem, isRecording, deviceDisplayName);
	}

	// Initial status bar update
	refreshStatusBar().catch(err => console.error('Error refreshing status bar:', err));

	function createComment(transcript: string) {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('No active editor found. Please open a file to add comments.');
			return;
		}

		const document = editor.document;
		const firstLine = document.lineAt(0);
		const range = new vscode.Range(0, 0, 0, firstLine.text.length);

		// Create a comment with the transcript text
		const comment: vscode.Comment = {
			body: new vscode.MarkdownString(transcript),
			mode: vscode.CommentMode.Preview,
			author: { name: 'PR Notes' }
		};

		// Create comment thread on the first line
		commentController.createCommentThread(document.uri, range, [comment]);
	}

	interface WordInfo {
		word: string;
		speakerTag: number;
		startOffset: string;
		endOffset: string;
	}

	async function transcribeAudio(audioData: Buffer, audioFilePath: string): Promise<string> {
		const audioBase64 = audioData.toString('base64');
		
		try {
			const response = await fetch(`${TRANSCRIPTION_SERVER_URL}/transcribe`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					audio: audioBase64,
				}),
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
				throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
			}

			const data = await response.json() as { words?: WordInfo[] };
			
			if (!data.words || !Array.isArray(data.words)) {
				throw new Error('No words array in response');
			}

			// Format words with speaker labels
			const words: WordInfo[] = data.words;
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

			return formattedTranscript.trim();
		} catch (error) {
			if (error instanceof TypeError && error.message.includes('fetch')) {
				throw new Error('Failed to connect to transcription server. Make sure the Docker container is running on port 3000.');
			}
			throw error;
		}
	}

	function startServer() {
		if (serverProcess) {
			return;
		}

		serverProcess = spawn('node', [serverPath], {
			stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
			cwd: process.cwd()
		});

		// Handle child process events
		serverProcess.on('close', (code, signal) => {
			console.log(`Server process exited with code ${code}, Signal: ${signal}`);
			serverProcess = null;
			isRecording = false;
			// Clean up context collector if recording was interrupted
			if (pendingContext === null) {
				contextCollector.clear();
			}
			pendingContext = null;
			refreshStatusBar().catch(err => console.error('Error refreshing status bar:', err));
		});

		serverProcess.on('message', async (message: { type: string; data: string }) => {
			console.log("We have a message");
			if (message.type === 'audio') {
				const audioData = Buffer.from(message.data, 'base64');
				
				
				const storageUri = context.globalStorageUri;
				const recordingsUri = vscode.Uri.joinPath(storageUri, 'recordings');
				
				// Create directory 
				await vscode.workspace.fs.createDirectory(recordingsUri);

				console.log(recordingsUri); 
				
				// Write the file
				const fileName = `${Date.now()}.wav`;
				const fileUri = vscode.Uri.joinPath(recordingsUri, fileName);
				await vscode.workspace.fs.writeFile(fileUri, audioData);
				
				vscode.window.showInformationMessage(`Recording saved: ${fileName}`);

				// Save context file 
				if (pendingContext && pendingContext.length > 0) {
					const contextFileName = fileName.replace('.wav', '.context.json');
					const contextUri = vscode.Uri.joinPath(recordingsUri, contextFileName);
					const contextJson = JSON.stringify(pendingContext, null, 2);
					const contextBuffer = Buffer.from(contextJson, 'utf8');
					await vscode.workspace.fs.writeFile(contextUri, contextBuffer);
					console.log(`Context saved: ${contextFileName}`);
				}
				pendingContext = null;
				
				// Transcribe the audio
				try {
					const transcript = await transcribeAudio(audioData, fileName);
					
					// Save transcript as .txt file with same base name
					const transcriptFileName = fileName.replace('.wav', '.txt');
					const transcriptUri = vscode.Uri.joinPath(recordingsUri, transcriptFileName);
					const transcriptBuffer = Buffer.from(transcript, 'utf8');
					await vscode.workspace.fs.writeFile(transcriptUri, transcriptBuffer);
					
					vscode.window.showInformationMessage(`Transcript saved: ${transcriptFileName}`);
					// TODO: Determine what line to put this on 
					// Create comment on first line
					createComment(transcript);
				} catch (error) {
					console.error('Transcription failed:', error);
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					vscode.window.showErrorMessage(`Failed to transcribe audio: ${errorMessage}`);
				}
				
				isRecording = false;
				refreshStatusBar().catch(err => console.error('Error refreshing status bar:', err));
			}
		});

		serverProcess.on('error', (err) => {
			console.error('Failed to start server process:', err);
			serverProcess = null;
			isRecording = false;
			if (pendingContext === null) {
				contextCollector.clear();
			}
			pendingContext = null;
			refreshStatusBar().catch(err => console.error('Error refreshing status bar:', err));
		});

		// Capture stdout, shown in debug console
		serverProcess.stdout?.on('data', (data) => {
			console.log(`[Server]: ${data.toString().trim()}`);
		});
	}

	function handleStartRecording() {
		if (isRecording) {
			return;
		}

		startServer();
		
		const selectedDevice = getSelectedDevice();
		contextCollector.startRecording();
		
		// Wait then send start 
		setTimeout(async () => {
			if (serverProcess && serverProcess.send) {
				serverProcess.send({ command: 'start', device: selectedDevice });
				isRecording = true;
				await refreshStatusBar();
			}
		}, 100);
	}

	function handleStopRecording() {
		if (!isRecording || !serverProcess || !serverProcess.send) {
			return; // Not recording
		}

		// Stop context collection and store the context
		pendingContext = contextCollector.stopRecording();

		serverProcess.send({ command: 'stop' });
	}

	async function handleSelectDevice(): Promise<void> {
		const selectedDeviceId = await selectAudioDevice();
		if (selectedDeviceId) {
			await refreshStatusBar();
			// Look up device name for the message
			const devices = await listAudioDevices();
			const device = devices.find(d => d.id === selectedDeviceId);
			const deviceName = device?.name || selectedDeviceId;
			vscode.window.showInformationMessage(`Audio input device set to: ${deviceName}`);
		}
	}

	// Status bar menu command
	const showMenuDisposable = vscode.commands.registerCommand('pr-notes.showMenu', async () => {
		const selectedDeviceId = getSelectedDevice();
		let deviceDisplayName: string | undefined = undefined;
		
		if (selectedDeviceId && selectedDeviceId !== 'default') {
			// Look up device name from the device list
			const devices = await listAudioDevices();
			const device = devices.find(d => d.id === selectedDeviceId);
			deviceDisplayName = device?.name;
		}

		const callbacks: StatusBarCallbacks = {
			onStartRecording: handleStartRecording,
			onStopRecording: handleStopRecording,
			onSelectDevice: handleSelectDevice
		};

		await showStatusBarMenu(isRecording, deviceDisplayName, callbacks);
		await refreshStatusBar();
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
	context.subscriptions.push(showMenuDisposable);
	context.subscriptions.push(helloWorldDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}

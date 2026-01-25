// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';

import {spawn, ChildProcess} from 'child_process';
import { AudioService } from './audioService';
import { DiarizationApiClient } from './apiClient';
import { createStatusBarItem, updateStatusBar, showStatusBarMenu, StatusBarCallbacks } from './statusBar';
import { getSession, getAuthState, onSessionChange, registerSessionChangeListener } from './githubAuth';
import { getSelectedDevice, selectAudioDevice, listAudioDevices } from './audioDeviceManager';
import { ContextCollector, RecordingContext } from './contextCollector';
import { WordInfo, SpeakerSegment, ClassifiedSegment, TransformedSegment, groupWordsBySpeaker, findCommentLocation, findCommentLocationsBatch } from './speechAlignment';
import { getPrContext } from './gitHubPrContext';
import { postReviewComments, type ReviewCommentInput } from './githubPrComments';
import { getRepositoryRelativePath } from './utils/filePath';

const TRANSCRIPTION_SERVER_URL = 'http://localhost:3000';

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

	// Check service health on activation
	audioService.checkServiceHealth().then(isHealthy => {
		if (isHealthy) {
			console.log('Diarization service is ready');
		}
	});

	// Recording functionality setup
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

		const authState = await getAuthState();
		updateStatusBar(statusBarItem, isRecording, deviceDisplayName, authState.accountLabel);
	}

	// Initial status bar update
	refreshStatusBar().catch(err => console.error('Error refreshing status bar:', err));

	// Auth: refresh status bar when GitHub sessions change (e.g. sign in/out from Accounts menu)
	context.subscriptions.push(registerSessionChangeListener());
	context.subscriptions.push(onSessionChange(() => {
		refreshStatusBar().catch(err => console.error('Error refreshing status bar:', err));
	}));

	async function createComments(transformedSegments: TransformedSegment[], contexts: RecordingContext[]): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('No active editor found. Please open a file to add comments.');
			return;
		}

		const document = editor.document;
		
		// Get current file path for context matching (handles git: URIs from diff view)
		const currentFile = getRepositoryRelativePath(document.uri);

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

		// Build GitHub review comment payload (path, 1-based line, body) and create VS Code threads
		const reviewComments: ReviewCommentInput[] = [];
		const filePath = currentFile ?? '';

		for (let i = 0; i < segmentsToComment.length; i++) {
			const segment = segmentsToComment[i];
			const range = ranges[i];

			// Format comment text with speaker label using transformed text
			const commentText = `${segment.transformedText}`;

			// Create comment
			const comment: vscode.Comment = {
				body: new vscode.MarkdownString(commentText),
				mode: vscode.CommentMode.Preview,
				author: { name: 'PR Notes' }
			};

			// Create comment thread at the determined location
			commentController.createCommentThread(document.uri, range, [comment]);

			// Accumulate for GitHub (1-based line)
			const line = range.start.line >= 0 ? range.start.line + 1 : 1;
			reviewComments.push({ path: filePath, line, body: commentText });
		}

		// Show completion message for local comments
		const localMsg = `Created ${segmentsToComment.length} comment(s) in ${currentFile}`;

		// Optionally post to GitHub
		const postToGitHub = vscode.workspace.getConfiguration('pr-notes').get<boolean>('postToGitHub') ?? true;
		if (!postToGitHub) {
			vscode.window.showInformationMessage(localMsg);
			return;
		}

		const session = await getSession(false);
		if (!session) {
			vscode.window.showInformationMessage(`${localMsg} Sign in and use a PR branch to post to GitHub.`);
			return;
		}

		// Check if file path was successfully extracted (required for GitHub API)
		if (!currentFile) {
			vscode.window.showWarningMessage(
				`Could not determine file path from diff view. Comments created locally but not posted to GitHub.`
			);
			vscode.window.showInformationMessage(localMsg);
			return;
		}

		const prContext = await getPrContext(session.accessToken);
		if (!prContext) {
			vscode.window.showInformationMessage(`${localMsg} Sign in and use a PR branch to post to GitHub.`);
			return;
		}

		const result = await postReviewComments(reviewComments, prContext, session.accessToken);
		if (result.success) {
			vscode.window.showInformationMessage(`Created ${segmentsToComment.length} comment(s) in ${currentFile} and on GitHub.`);
		} else {
			vscode.window.showInformationMessage(localMsg);
			vscode.window.showErrorMessage(`Could not post to GitHub: ${result.error ?? 'Unknown error'}`);
		}
	}

	async function transcribeAudio(audioData: Buffer, audioFilePath: string): Promise<WordInfo[]> {
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

			return data.words;
		} catch (error) {
			if (error instanceof TypeError && error.message.includes('fetch')) {
				throw new Error('Failed to connect to transcription server. Make sure the Docker container is running on port 3000.');
			}
			throw error;
		}
	}

	async function classifySegments(segments: SpeakerSegment[]): Promise<ClassifiedSegment[]> {
		try {
			const response = await fetch(`${TRANSCRIPTION_SERVER_URL}/classify`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					segments: segments,
				}),
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
				throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
			}

			const data = await response.json() as { classifiedSegments?: ClassifiedSegment[] };
			
			if (!data.classifiedSegments || !Array.isArray(data.classifiedSegments)) {
				throw new Error('No classifiedSegments array in response');
			}

			return data.classifiedSegments;
		} catch (error) {
			if (error instanceof TypeError && error.message.includes('fetch')) {
				throw new Error('Failed to connect to transcription server. Make sure the Docker container is running on port 3000.');
			}
			throw error;
		}
	}

	async function transformSegments(classifiedSegments: ClassifiedSegment[]): Promise<TransformedSegment[]> {
		try {
			const response = await fetch(`${TRANSCRIPTION_SERVER_URL}/transform`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					classifiedSegments: classifiedSegments,
				}),
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
				throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
			}

			const data = await response.json() as { transformedSegments?: TransformedSegment[] };
			
			if (!data.transformedSegments || !Array.isArray(data.transformedSegments)) {
				throw new Error('No transformedSegments array in response');
			}

			return data.transformedSegments;
		} catch (error) {
			if (error instanceof TypeError && error.message.includes('fetch')) {
				throw new Error('Failed to connect to transcription server. Make sure the Docker container is running on port 3000.');
			}
			throw error;
		}
	}

	async function splitSegments(classifiedSegments: ClassifiedSegment[]): Promise<ClassifiedSegment[]> {
		try {
			const response = await fetch(`${TRANSCRIPTION_SERVER_URL}/split`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					classifiedSegments: classifiedSegments,
				}),
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
				throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
			}

			const data = await response.json() as { splitSegments?: ClassifiedSegment[] };
			
			if (!data.splitSegments || !Array.isArray(data.splitSegments)) {
				throw new Error('No splitSegments array in response');
			}

			return data.splitSegments;
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
				
				// Prepare file names and data
				const fileName = `${Date.now()}.wav`;
				const fileUri = vscode.Uri.joinPath(recordingsUri, fileName);
				const contextsToUse = pendingContext; // Store before clearing
				pendingContext = null;

				// Prepare context file data if available
				const fileWritePromises: Promise<void>[] = [
					new Promise<void>((resolve, reject) => {
						vscode.workspace.fs.writeFile(fileUri, audioData).then(() => {
							vscode.window.showInformationMessage(`Recording saved: ${fileName}`);
							resolve();
						}, reject);
					})
				];

				if (contextsToUse && contextsToUse.length > 0) {
					const contextFileName = fileName.replace('.wav', '.context.json');
					const contextUri = vscode.Uri.joinPath(recordingsUri, contextFileName);
					const contextJson = JSON.stringify(contextsToUse, null, 2);
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

				// Start file writes in parallel (don't await yet - start transcription immediately)
				// File writes will complete in background
				Promise.all(fileWritePromises).catch(err => {
					console.error('Error saving files:', err);
				});
				
				// Transcribe the audio (start immediately, don't wait for file writes)
				try {
					const words = await transcribeAudio(audioData, fileName);
					
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
					
					// Save transcript as .txt file (add to parallel file writes)
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

					// Wait for all file writes to complete (including transcript)
					await Promise.all(fileWritePromises);
					
					// Process audio with progress notifications
					await vscode.window.withProgress({
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
							return;
						}
						
						// Classify segments
						progress.report({ increment: 20, message: `Classifying ${segments.length} segments...` });
						let classifiedSegments: ClassifiedSegment[];
						try {
							classifiedSegments = await classifySegments(segments);
							console.log(`[EXTENSION] Classified ${segments.length} segments into ${classifiedSegments.length} classified segments`);
						} catch (error) {
							console.error('Classification failed:', error);
							const errorMessage = error instanceof Error ? error.message : 'Unknown error';
							vscode.window.showErrorMessage(`Failed to classify speech segments: ${errorMessage}`);
							return;
						}
						
						// Split segments based on topic and context
						progress.report({ increment: 20, message: `Splitting ${classifiedSegments.length} segments...` });
						let splitClassifiedSegments: ClassifiedSegment[];
						try {
							splitClassifiedSegments = await splitSegments(classifiedSegments);
							console.log(`[EXTENSION] Split ${classifiedSegments.length} segments into ${splitClassifiedSegments.length} split segments`);
						} catch (error) {
							console.error('Splitting failed:', error);
							const errorMessage = error instanceof Error ? error.message : 'Unknown error';
							vscode.window.showErrorMessage(`Failed to split speech segments: ${errorMessage}`);
							return;
						}
						
						// Transform segments
						progress.report({ increment: 20, message: `Transforming ${splitClassifiedSegments.length} segments...` });
						let transformedSegments: TransformedSegment[];
						try {
							transformedSegments = await transformSegments(splitClassifiedSegments);
							console.log(`[EXTENSION] Transformed ${splitClassifiedSegments.length} segments into ${transformedSegments.length} transformed segments`);
							
							// Log classification breakdown
							const classificationCounts = transformedSegments.reduce((acc, seg) => {
								acc[seg.classification] = (acc[seg.classification] || 0) + 1;
								return acc;
							}, {} as Record<string, number>);
							console.log(`[EXTENSION] Classification breakdown:`, classificationCounts);
						} catch (error) {
							console.error('Transformation failed:', error);
							const errorMessage = error instanceof Error ? error.message : 'Unknown error';
							vscode.window.showErrorMessage(`Failed to transform speech segments: ${errorMessage}`);
							return;
						}
						
						// Create comments aligned to code using context snapshots with transformed text
						const segmentsToComment = transformedSegments.filter(seg => seg.classification !== 'Ignore');
						progress.report({ increment: 20, message: `Finding locations for ${segmentsToComment.length} comments...` });
						await createComments(transformedSegments, contextsToUse || []);
						
						progress.report({ increment: 20, message: "Complete!" });
					});
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

	// Register command for checking service health (diarisation)
	const checkHealthDisposable = vscode.commands.registerCommand('pr-notes.checkHealth', async () => {
		const isHealthy = await audioService.checkServiceHealth();
		if (isHealthy) {
			vscode.window.showInformationMessage('Diarization service is healthy and ready!');
		} else {
			vscode.window.showWarningMessage('Diarization service is not available. Please check the Docker container.');
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

		await showStatusBarMenu(isRecording, deviceDisplayName, callbacks, authState);
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

	const loginDisposable = vscode.commands.registerCommand('pr-notes.login', handleLogin);

	context.subscriptions.push(statusBarItem);
	context.subscriptions.push(commentController);
	context.subscriptions.push(processAudioDisposable);
	context.subscriptions.push(checkHealthDisposable);
	context.subscriptions.push(showMenuDisposable);
	context.subscriptions.push(helloWorldDisposable);
	context.subscriptions.push(loginDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
	// Cleanup if needed
}

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as readline from 'readline';

import {spawn, ChildProcess} from 'child_process';
import { AudioService } from './audioService';
import { DiarizationApiClient } from './apiClient';
import { createStatusBarItem, updateStatusBar, showStatusBarMenu, StatusBarCallbacks } from './statusBar';
import { getSession, getAuthState, onSessionChange, registerSessionChangeListener } from './githubAuth';
import { getSelectedDevice, selectAudioDevice, listAudioDevices } from './audioDeviceManager';
import { ContextCollector, RecordingContext } from './contextCollector';
import { WordInfo, groupWordsBySpeaker, findCommentLocationsBatch } from './speechAlignment';
import type { SpeakerSegment, TransformedSegment } from './types';
import { getPrContext } from './gitHubPrContext';
import { postReviewComments, type ReviewCommentInput } from './githubPrComments';
import { getRepositoryRelativePath } from './utils/filePath';
import { processSegmentsCombined, initializeGeminiService, resetGeminiClient } from './services/gemini';

let audioService: AudioService;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('PR Notes extension is now active!');

	// Initialize Gemini service with secret storage access
	const GEMINI_API_KEY_SECRET = 'pr-notes.geminiApiKey';
	initializeGeminiService(async () => {
		return await context.secrets.get(GEMINI_API_KEY_SECRET);
	});

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

		// Find all comment locations in parallel using batch API (uses local Gemini)
		const ranges = await findCommentLocationsBatch(
			segmentsToComment,
			contexts,
			document,
			currentFile || ''
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

	// Fluid helper process for transcription/diarization
	let fluidHelper: ChildProcess | null = null;
	let pendingSegments: SpeakerSegment[] = [];
	let fluidHelperReady = false;

	// Model download timeout: 15 minutes for first-run downloads (~650MB)
	const MODEL_DOWNLOAD_TIMEOUT_MS = 900000;

	/**
	 * Start the fluid-helper process for transcription and diarization
	 * @param showSuccessMessage - Whether to show a success message when models are ready
	 */
	async function startFluidHelper(showSuccessMessage: boolean = false): Promise<void> {
		if (fluidHelper && fluidHelperReady) {
			if (showSuccessMessage) {
				vscode.window.showInformationMessage('Speech models are already downloaded and ready!');
			}
			return;
		}

		// Show progress while loading models (can take a while on first run)
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Loading Speech Models",
			cancellable: false
		}, async (progress) => {
			modelDownloadProgress = progress;
			
			return new Promise<void>((resolve, reject) => {
				const helperPath = path.join(context.extensionPath, 'bin', 'fluid-helper');
				console.log(`[FluidHelper] Starting helper at: ${helperPath}`);

				progress.report({ message: 'Starting speech recognition engine...' });

				fluidHelper = spawn(helperPath, [], {
					stdio: ['pipe', 'pipe', 'pipe']
				});

				// Parse JSON lines from stdout
				const rl = readline.createInterface({ input: fluidHelper.stdout! });
				rl.on('line', (line) => {
					try {
						const msg = JSON.parse(line);
						handleFluidHelperMessage(msg, showSuccessMessage);
						if (msg.type === 'ready') {
							fluidHelperReady = true;
							modelDownloadProgress = null;
							resolve();
						}
					} catch (e) {
						console.error('[FluidHelper] Invalid JSON:', line);
					}
				});

				fluidHelper.stderr?.on('data', (data) => {
					console.error(`[FluidHelper] stderr: ${data.toString().trim()}`);
				});

				fluidHelper.on('close', (code) => {
					console.log(`[FluidHelper] Process exited with code ${code}`);
					fluidHelper = null;
					fluidHelperReady = false;
					modelDownloadProgress = null;
				});

				fluidHelper.on('error', (err) => {
					console.error('[FluidHelper] Process error:', err);
					fluidHelper = null;
					fluidHelperReady = false;
					modelDownloadProgress = null;
					reject(err);
				});

				// Send init command
				fluidHelper.stdin!.write(JSON.stringify({ type: 'init' }) + '\n');

				// Set timeout for initialization (model download can take a while)
				setTimeout(() => {
					if (!fluidHelperReady) {
						modelDownloadProgress = null;
						reject(new Error('Speech model initialization timed out. First run downloads ~650MB of models - please try again with a stable internet connection.'));
					}
				}, MODEL_DOWNLOAD_TIMEOUT_MS);
			});
		});
	}

	// Track model download progress notification
	let modelDownloadProgress: vscode.Progress<{ message?: string; increment?: number }> | null = null;

	/**
	 * Handle messages from fluid-helper
	 * @param showSuccessMessage - Whether to show a success message when models are ready
	 */
	async function handleFluidHelperMessage(msg: { type: string; [key: string]: unknown }, showSuccessMessage: boolean = false) {
		switch (msg.type) {
			case 'ready':
				console.log('[FluidHelper] Models loaded and ready');
				if (showSuccessMessage) {
					vscode.window.showInformationMessage('Speech models downloaded and ready! You can now start recording.');
				}
				break;
			case 'progress':
				// Model download progress
				console.log(`[FluidHelper] Progress: ${msg.stage} - ${msg.message} (${msg.percent ?? '...'}%)`);
				if (modelDownloadProgress) {
					// Format stage name for display
					const stageName = msg.stage === 'asr' ? 'Speech Recognition' : 
									  msg.stage === 'diarization' ? 'Speaker Detection' : 
									  String(msg.stage);
					const percent = msg.percent ? ` (${msg.percent}%)` : '';
					modelDownloadProgress.report({ 
						message: `${stageName}: ${msg.message}${percent}`,
						increment: msg.percent ? 5 : 0
					});
				}
				break;
			case 'volatile':
				// Interim transcription results - update status bar
				console.log(`[FluidHelper] Volatile: ${msg.text}`);
				break;
			case 'confirmed':
				console.log(`[FluidHelper] Confirmed: ${msg.text} (confidence: ${msg.confidence})`);
				break;
			case 'segment':
				// Collect segments for Gemini processing
				pendingSegments.push({
					speakerTag: msg.speakerId as number,
					text: msg.text as string,
					startTime: msg.start as number,
					endTime: msg.end as number
				});
				break;
			case 'done':
				// All segments received, process with Gemini
				await processRecordedSegments(pendingSegments, pendingContext || []);
				pendingSegments = [];
				break;
			case 'error':
				console.error(`[FluidHelper] Error: ${msg.message}`);
				vscode.window.showErrorMessage(`Transcription error: ${msg.message}`);
				break;
		}
	}

	/**
	 * Process recorded segments with Gemini and create comments
	 */
	async function processRecordedSegments(segments: SpeakerSegment[], contexts: RecordingContext[]) {
		if (segments.length === 0) {
			vscode.window.showWarningMessage('No speech segments found in recording.');
			return;
		}

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Processing Speech",
			cancellable: false
		}, async (progress) => {
			progress.report({ increment: 0, message: `Processing ${segments.length} segments...` });

			try {
				// Process segments with Gemini (classify, split, transform)
				const transformedSegments = await processSegmentsCombined(segments);
				console.log(`[EXTENSION] Processed ${segments.length} segments into ${transformedSegments.length} transformed segments`);

				// Log classification breakdown
				const classificationCounts = transformedSegments.reduce((acc, seg) => {
					acc[seg.classification] = (acc[seg.classification] || 0) + 1;
					return acc;
				}, {} as Record<string, number>);
				console.log(`[EXTENSION] Classification breakdown:`, classificationCounts);

				progress.report({ increment: 60, message: `Creating ${transformedSegments.length} comments...` });

				// Create comments
				await createComments(transformedSegments, contexts);

				progress.report({ increment: 40, message: "Complete!" });
			} catch (error) {
				console.error('Processing failed:', error);
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				vscode.window.showErrorMessage(`Failed to process speech: ${errorMessage}`);
			}
		});

		isRecording = false;
		refreshStatusBar().catch(err => console.error('Error refreshing status bar:', err));
	}

	/**
	 * Send audio data to fluid-helper for processing
	 */
	function sendAudioToFluidHelper(audioData: Buffer) {
		if (!fluidHelper?.stdin) {
			console.error('[FluidHelper] Not ready to receive audio');
			return;
		}

		// Convert WAV to PCM and send to helper
		// The fluid-helper expects 16kHz mono PCM data
		const pcmData = extractPCMFromWAV(audioData);
		const msg = { type: 'audio', data: pcmData.toString('base64'), sampleRate: 16000 };
		fluidHelper.stdin.write(JSON.stringify(msg) + '\n');
	}

	/**
	 * Extract PCM data from WAV buffer
	 * Assumes WAV is 16-bit PCM (most common format from sox)
	 */
	function extractPCMFromWAV(wavBuffer: Buffer): Buffer {
		// WAV header is typically 44 bytes
		// Find "data" chunk
		let dataOffset = 44;
		for (let i = 0; i < wavBuffer.length - 4; i++) {
			if (wavBuffer.toString('ascii', i, i + 4) === 'data') {
				// Skip "data" + 4 bytes for chunk size
				dataOffset = i + 8;
				break;
			}
		}
		return wavBuffer.subarray(dataOffset);
	}

	/**
	 * Signal end of audio to fluid-helper
	 */
	function endFluidHelperAudio() {
		if (!fluidHelper?.stdin) {
			return;
		}
		fluidHelper.stdin.write(JSON.stringify({ type: 'end' }) + '\n');
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
			if (pendingContext === null) {
				contextCollector.clear();
			}
			pendingContext = null;
			refreshStatusBar().catch(err => console.error('Error refreshing status bar:', err));
		});

		serverProcess.on('message', async (message: { type: string; data: string }) => {
			console.log("[EXTENSION] Received audio from recorder");
			if (message.type === 'audio') {
				const audioData = Buffer.from(message.data, 'base64');
				const contextsToUse = pendingContext;
				pendingContext = null;

				// Save audio file
				const storageUri = context.globalStorageUri;
				const recordingsUri = vscode.Uri.joinPath(storageUri, 'recordings');
				await vscode.workspace.fs.createDirectory(recordingsUri);

				const fileName = `${Date.now()}.wav`;
				const fileUri = vscode.Uri.joinPath(recordingsUri, fileName);
				await vscode.workspace.fs.writeFile(fileUri, audioData);
				console.log(`[EXTENSION] Recording saved: ${fileName}`);

				// Save context if available
				if (contextsToUse && contextsToUse.length > 0) {
					const contextFileName = fileName.replace('.wav', '.context.json');
					const contextUri = vscode.Uri.joinPath(recordingsUri, contextFileName);
					const contextBuffer = Buffer.from(JSON.stringify(contextsToUse, null, 2), 'utf8');
					await vscode.workspace.fs.writeFile(contextUri, contextBuffer);
				}

				// Process with fluid-helper
				try {
					// Start helper if not running
					await startFluidHelper();

					// Store context for when segments arrive
					pendingContext = contextsToUse;

					// Send audio to helper
					sendAudioToFluidHelper(audioData);
					endFluidHelperAudio();

				} catch (error) {
					console.error('Failed to process with fluid-helper:', error);
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					vscode.window.showErrorMessage(`Failed to start transcription: ${errorMessage}. Make sure fluid-helper is built.`);
					isRecording = false;
					refreshStatusBar().catch(err => console.error('Error refreshing status bar:', err));
				}
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

		serverProcess.stdout?.on('data', (data) => {
			console.log(`[Recorder]: ${data.toString().trim()}`);
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

	// Download speech models command - allows users to pre-download models before first recording
	const downloadModelsDisposable = vscode.commands.registerCommand('pr-notes.downloadModels', async () => {
		try {
			await startFluidHelper(true); // Show success message when complete
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			vscode.window.showErrorMessage(`Failed to download speech models: ${errorMessage}`);
		}
	});

	// Set Gemini API key command - prompts user to enter their API key (stored securely)
	const setGeminiApiKeyDisposable = vscode.commands.registerCommand('pr-notes.setGeminiApiKey', async () => {
		const currentKey = await context.secrets.get(GEMINI_API_KEY_SECRET);
		
		const apiKey = await vscode.window.showInputBox({
			prompt: 'Enter your Gemini API key (get one at https://aistudio.google.com/app/apikey)',
			placeHolder: 'AIza...',
			value: currentKey ? '••••••••' + currentKey.slice(-4) : '',
			password: true,
			ignoreFocusOut: true,
			validateInput: (value) => {
				if (!value || value.trim().length === 0) {
					return 'API key cannot be empty';
				}
				if (value.startsWith('••••')) {
					return 'Please enter a new API key or press Escape to cancel';
				}
				return null;
			}
		});

		if (apiKey && !apiKey.startsWith('••••')) {
			try {
				await context.secrets.store(GEMINI_API_KEY_SECRET, apiKey.trim());
				// Reset the Gemini client so it picks up the new key
				resetGeminiClient();
				vscode.window.showInformationMessage('Gemini API key saved securely!');
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				vscode.window.showErrorMessage(`Failed to save API key: ${errorMessage}`);
			}
		}
	});

	context.subscriptions.push(statusBarItem);
	context.subscriptions.push(commentController);
	context.subscriptions.push(processAudioDisposable);
	context.subscriptions.push(checkHealthDisposable);
	context.subscriptions.push(showMenuDisposable);
	context.subscriptions.push(helloWorldDisposable);
	context.subscriptions.push(loginDisposable);
	context.subscriptions.push(downloadModelsDisposable);
	context.subscriptions.push(setGeminiApiKeyDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
	// Cleanup if needed
}

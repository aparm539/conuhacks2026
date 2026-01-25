import * as vscode from 'vscode';
import { ContextCollector, RecordingContext } from '../contextCollector';
import { getSelectedDevice } from '../audioDeviceManager';
import { ServerManager } from './serverManager';

/**
 * Manages recording state and operations
 */
export class RecordingService {
	private isRecording = false;
	private pendingContext: RecordingContext[] | null = null;
	private readonly contextCollector: ContextCollector;
	private readonly serverManager: ServerManager;

	constructor(serverManager: ServerManager) {
		this.contextCollector = new ContextCollector();
		this.serverManager = serverManager;
	}

	/**
	 * Start recording
	 * Note: Server should already be started by extension.ts - this method only sends the start command
	 */
	async startRecording(): Promise<void> {
		if (this.isRecording) {
			return;
		}

		// Server is already started in extension.ts, so we don't need to start it again here
		// Just verify it's running before proceeding
		if (!this.serverManager.isRunning()) {
			console.warn('[RecordingService] Server not running, attempting to start...');
			this.serverManager.start();
		}
		
		const selectedDevice = getSelectedDevice();
		
		// Start context collection first, then send audio start command
		// This ensures context timestamps align with audio recording start
		this.contextCollector.startRecording();
		
		// Send start command immediately (removed artificial delay)
		// The delay was causing context/audio timing misalignment
		if (this.serverManager.send({ command: 'start', device: selectedDevice })) {
			this.isRecording = true;
		} else {
			console.error('[RecordingService] Failed to send start command to server');
			this.contextCollector.stopRecording(); // Clean up if start failed
		}
	}

	/**
	 * Stop recording
	 */
	stopRecording(): void {
		if (!this.isRecording || !this.serverManager.isRunning()) {
			return;
		}

		// Stop context collection and store the context
		this.pendingContext = this.contextCollector.stopRecording();

		this.serverManager.send({ command: 'stop' });
	}

	/**
	 * Get pending context (clears it after retrieval)
	 */
	getPendingContext(): RecordingContext[] | null {
		const context = this.pendingContext;
		this.pendingContext = null;
		return context;
	}

	/**
	 * Clear pending context
	 */
	clearPendingContext(): void {
		this.pendingContext = null;
	}

	/**
	 * Check if currently recording
	 */
	getIsRecording(): boolean {
		return this.isRecording;
	}

	/**
	 * Set recording state (used when recording completes)
	 */
	setIsRecording(value: boolean): void {
		this.isRecording = value;
	}

	/**
	 * Clear context collector (used when server closes)
	 */
	clearContext(): void {
		if (this.pendingContext === null) {
			this.contextCollector.clear();
		}
		this.pendingContext = null;
	}
}

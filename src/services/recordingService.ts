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
	 */
	async startRecording(): Promise<void> {
		if (this.isRecording) {
			return;
		}

		this.serverManager.start();
		
		const selectedDevice = getSelectedDevice();
		this.contextCollector.startRecording();
		
		// Wait then send start command
		setTimeout(async () => {
			if (this.serverManager.send({ command: 'start', device: selectedDevice })) {
				this.isRecording = true;
			}
		}, RECORDING_START_DELAY_MS);
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

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ServerManagerCallbacks {
	onClose?: (code: number | null, signal: NodeJS.Signals | null) => void;
	onError?: (err: Error) => void;
	onMessage?: (message: { type: string; data: string }) => void;
}

/**
 * Manages the lifecycle of the transcription server process
 */
export class ServerManager {
	private serverProcess: ChildProcess | null = null;
	private readonly serverPath: string;

	constructor(extensionPath: string) {
		this.serverPath = path.join(extensionPath, 'out', 'server.js');
	}

	/**
	 * Start the server process if not already running
	 */
	start(callbacks: ServerManagerCallbacks = {}): void {
		if (this.serverProcess) {
			return;
		}

		this.serverProcess = spawn('node', [this.serverPath], {
			stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
			cwd: process.cwd()
		});

		// Handle child process events
		this.serverProcess.on('close', (code, signal) => {
			console.log(`Server process exited with code ${code}, Signal: ${signal}`);
			this.serverProcess = null;
			callbacks.onClose?.(code, signal);
		});

		this.serverProcess.on('error', (err) => {
			console.error('Failed to start server process:', err);
			this.serverProcess = null;
			callbacks.onError?.(err);
		});

		this.serverProcess.on('message', (message: { type: string; data: string }) => {
			callbacks.onMessage?.(message);
		});

		// Capture stdout, shown in debug console
		this.serverProcess.stdout?.on('data', (data) => {
			console.log(`[Server]: ${data.toString().trim()}`);
		});
	}

	/**
	 * Send a command to the server process
	 */
	send(command: { command: string; device?: string }): boolean {
		if (!this.serverProcess || !this.serverProcess.send) {
			return false;
		}
		this.serverProcess.send(command);
		return true;
	}

	/**
	 * Check if server is running
	 */
	isRunning(): boolean {
		return this.serverProcess !== null;
	}

	/**
	 * Stop the server process
	 */
	stop(): void {
		if (this.serverProcess) {
			this.serverProcess.kill();
			this.serverProcess = null;
		}
	}
}

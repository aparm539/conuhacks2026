/**
 * Audio service for recording and processing audio in VS Code extension
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DiarizationApiClient } from './apiClient';
import { DiarizationResponse } from './types';

export class AudioService {
    private apiClient: DiarizationApiClient;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext, apiClient?: DiarizationApiClient) {
        this.context = context;
        this.apiClient = apiClient || new DiarizationApiClient();
    }

    /**
     * Get the temporary directory for storing audio files
     */
    private getTempDir(): string {
        const tempDir = path.join(this.context.globalStoragePath, 'audio-temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        return tempDir;
    }

    /**
     * Record audio from microphone
     * Note: VS Code extensions run in Node.js, so we'll need to use
     * a native module or external process for audio recording.
     * This is a placeholder that shows the expected interface.
     */
    async recordAudio(durationSeconds: number = 30): Promise<string> {
        // In a real implementation, you would:
        // 1. Use a native Node.js module for audio recording (like node-record-lpcm16)
        // 2. Or spawn a child process to use system audio recording tools
        // 3. Save the audio to a temporary file
        
        const tempDir = this.getTempDir();
        const audioPath = path.join(tempDir, `recording-${Date.now()}.wav`);
        
        // Placeholder: In real implementation, record audio here
        // For now, we'll show an error that recording needs to be implemented
        throw new Error(
            'Audio recording not yet implemented. ' +
            'Please use an audio file or implement recording using a native module.'
        );
    }

    /**
     * Process an audio file with speaker diarization
     */
    async processAudioFile(audioFilePath: string): Promise<DiarizationResponse> {
        try {
            // Check if file exists
            if (!fs.existsSync(audioFilePath)) {
                throw new Error(`Audio file not found: ${audioFilePath}`);
            }

            // Check file size (limit to 100MB)
            const stats = fs.statSync(audioFilePath);
            const maxSize = 100 * 1024 * 1024; // 100MB
            if (stats.size > maxSize) {
                throw new Error(`Audio file too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB. Maximum size is 100MB.`);
            }

            // Show progress notification
            const progressOptions: vscode.ProgressOptions = {
                location: vscode.ProgressLocation.Notification,
                title: 'Processing audio...',
                cancellable: false,
            };

            return await vscode.window.withProgress(
                progressOptions,
                async (progress) => {
                    progress.report({ increment: 0, message: 'Sending audio to diarization service...' });
                    
                    const result = await this.apiClient.processAudio(audioFilePath, (progressValue) => {
                        progress.report({ increment: progressValue, message: 'Processing audio...' });
                    });

                    progress.report({ increment: 100, message: 'Complete!' });
                    return result;
                }
            );
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to process audio: ${error.message}`);
                throw error;
            }
            throw error;
        }
    }

    /**
     * Process audio from a file path selected by the user
     */
    async processAudioFromFile(): Promise<DiarizationResponse | null> {
        try {
            // Show file picker
            const audioFile = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: 'Select Audio File',
                filters: {
                    'Audio Files': ['wav', 'mp3', 'm4a', 'flac', 'ogg'],
                    'All Files': ['*']
                }
            });

            if (!audioFile || audioFile.length === 0) {
                return null;
            }

            const audioPath = audioFile[0].fsPath;
            return await this.processAudioFile(audioPath);
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Error selecting audio file: ${error.message}`);
            }
            return null;
        }
    }

    /**
     * Format diarization results as text
     */
    formatResultsAsText(results: DiarizationResponse): string {
        let output = `Speaker Diarization Results\n`;
        output += `============================\n\n`;
        output += `Total Speakers: ${results.total_speakers}\n`;
        output += `Total Duration: ${results.total_duration.toFixed(2)}s\n`;
        output += `Segments: ${results.segments.length}\n\n`;
        output += `Segments:\n`;
        output += `---------\n\n`;

        results.segments.forEach((segment, index) => {
            output += `${index + 1}. ${segment.speaker}\n`;
            output += `   Time: ${segment.start.toFixed(2)}s - ${segment.end.toFixed(2)}s\n`;
            output += `   Duration: ${segment.duration.toFixed(2)}s\n\n`;
        });

        return output;
    }

    /**
     * Format diarization results as JSON
     */
    formatResultsAsJson(results: DiarizationResponse): string {
        return JSON.stringify(results, null, 2);
    }

    /**
     * Check if the API service is available
     */
    async checkServiceHealth(): Promise<boolean> {
        try {
            const health = await this.apiClient.checkHealth();
            return health.pipeline_loaded;
        } catch (error) {
            vscode.window.showWarningMessage(
                `Diarization service is not available: ${error instanceof Error ? error.message : 'Unknown error'}. ` +
                `Make sure the Docker container is running on ${this.apiClient.getBaseUrl()}`
            );
            return false;
        }
    }
}

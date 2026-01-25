/**
 * Audio service for recording and processing audio in VS Code extension
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
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

            // Validate file exists
            if (!fs.existsSync(audioPath)) {
                throw new Error(`Audio file not found: ${audioPath}`);
            }

            // Validate file size (limit to 100MB)
            const stats = fs.statSync(audioPath);
            const maxSize = 100 * 1024 * 1024; // 100MB
            if (stats.size > maxSize) {
                throw new Error(`Audio file too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB. Maximum size is 100MB.`);
            }

            return await this.apiClient.processAudio(audioPath);
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to process audio: ${error.message}`);
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

}

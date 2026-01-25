/**
 * API client for communicating with the speaker diarization service
 */
import * as vscode from 'vscode';
import { DiarizationResponse, ErrorResponse, HealthResponse, ApiConfig } from './types';

export class DiarizationApiClient {
    private config: ApiConfig;

    constructor(config?: Partial<ApiConfig>) {
        this.config = {
            baseUrl: config?.baseUrl || 'http://localhost:8000',
            timeout: config?.timeout || 300000, // 5 minutes default
        };
    }

    /**
     * Process an audio file for speaker diarization
     * @param audioFile Path to the audio file or File/Blob object
     * @param onProgress Optional progress callback
     */
    async processAudio(
        audioFile: string | File | Blob,
        onProgress?: (progress: number) => void
    ): Promise<DiarizationResponse> {
        try {
            // Prepare form data
            const formData = new FormData();
            
            if (typeof audioFile === 'string') {
                // If it's a file path, we need to read it as a file
                // In VS Code extension context, we'll need to use vscode.workspace.fs
                const fileData = await vscode.workspace.fs.readFile(vscode.Uri.file(audioFile));
                const fileName = audioFile.split(/[/\\]/).pop() || 'audio.wav';
                // Convert Uint8Array to ArrayBuffer for Blob constructor
                const arrayBuffer = fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength) as ArrayBuffer;
                const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
                formData.append('audio', blob, fileName);
            } else {
                // It's already a File or Blob
                formData.append('audio', audioFile, 'audio.wav');
            }

            // Create abort controller for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

            try {
                const response = await fetch(`${this.config.baseUrl}/process`, {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    const errorData: ErrorResponse = await response.json().catch(() => ({
                        success: false,
                        error: 'Unknown error',
                        message: response.statusText,
                    }));
                    throw new Error(errorData.message || errorData.error || `HTTP ${response.status}`);
                }

                const result: DiarizationResponse = await response.json();
                
                if (!result.success) {
                    throw new Error(result.message || 'Processing failed');
                }

                return result;
            } catch (error) {
                clearTimeout(timeoutId);
                if (error instanceof Error && error.name === 'AbortError') {
                    throw new Error('Request timeout: Audio processing took too long');
                }
                throw error;
            }
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to process audio: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Process audio from a buffer (useful for streaming)
     */
    async processAudioBuffer(
        audioBuffer: ArrayBuffer,
        filename: string = 'audio.wav',
        mimeType: string = 'audio/wav'
    ): Promise<DiarizationResponse> {
        const blob = new Blob([audioBuffer], { type: mimeType });
        return this.processAudio(blob);
    }

    /**
     * Get the base URL of the API
     */
    getBaseUrl(): string {
        return this.config.baseUrl;
    }

    /**
     * Update the API configuration
     */
    updateConfig(config: Partial<ApiConfig>): void {
        this.config = { ...this.config, ...config };
    }
}

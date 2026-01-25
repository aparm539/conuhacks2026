/**
 * API client for communicating with the speaker diarization service
 */
import * as vscode from 'vscode';
import { DiarizationResponse, ErrorResponse, ApiConfig } from './types';
import { HttpClient } from './services/httpClient';

export class DiarizationApiClient {
    private httpClient: HttpClient;
    private config: ApiConfig;

    constructor(config?: Partial<ApiConfig>) {
        this.config = {
            baseUrl: config?.baseUrl || 'http://localhost:8000',
            timeout: config?.timeout || 300000, // 5 minutes default
        };
        this.httpClient = new HttpClient(this.config.baseUrl, this.config.timeout);
    }


    /**
     * Process an audio file for speaker diarization
     * @param audioFile Path to the audio file or File/Blob object
     */
    async processAudio(
        audioFile: string | File | Blob
    ): Promise<DiarizationResponse> {
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

        const result = await this.httpClient.postFormData<DiarizationResponse>('/process', formData, {
            errorContext: 'Audio processing'
        });
        
        if (!result.success) {
            throw new Error(result.message || 'Processing failed');
        }

        return result;
    }

    /**
     * Get the base URL of the API
     */
    getBaseUrl(): string {
        return this.httpClient.getBaseUrl();
    }

    /**
     * Update the API configuration
     */
    updateConfig(config: Partial<ApiConfig>): void {
        this.config = { ...this.config, ...config };
        this.httpClient = new HttpClient(this.config.baseUrl, this.config.timeout);
    }
}

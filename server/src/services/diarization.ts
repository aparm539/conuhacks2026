import fs from 'fs';
import path from 'path';
import os from 'os';
import FormData from 'form-data';
import axios from 'axios';
import type { DiarizationResponse, DiarizationSpeakerSegment } from '../types';
import { DIARIZATION_TIMEOUT_MS } from '../config/constants';
import { parseDuration } from '../utils/duration';

const DIAR_SERVICE_URL = process.env.DIAR_SERVICE_URL || 'http://localhost:8000';

/**
 * Call diar-service to get speaker segments
 */
export async function getDiarization(audioBuffer: Buffer): Promise<DiarizationResponse> {
  const tempFilePath = path.join(os.tmpdir(), `audio-${Date.now()}.wav`);
  
  try {
    // Write audio buffer to temporary file
    fs.writeFileSync(tempFilePath, audioBuffer);
    
    // Create FormData for multipart/form-data upload
    const formData = new FormData();
    formData.append('audio', fs.createReadStream(tempFilePath), {
      filename: 'audio.wav',
      contentType: 'audio/wav'
    });
    
    // Call diar-service using axios (better form-data support)
    const response = await axios.post<DiarizationResponse>(
      `${DIAR_SERVICE_URL}/process`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: DIARIZATION_TIMEOUT_MS,
      }
    );
    
    const result = response.data;
    
    if (!result.success) {
      throw new Error(`Diarization failed: ${result.message || 'Unknown error'}`);
    }
    
    return result;
  } catch (err: unknown) {
    // Handle axios errors specifically
    if (axios.isAxiosError(err)) {
      // TypeScript type guard should narrow, but we'll be explicit
      const axiosError = err as import('axios').AxiosError;
      if (axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ENOTFOUND') {
        throw new Error(`Cannot connect to diar-service at ${DIAR_SERVICE_URL}. Is it running?`);
      }
      const errorMessage = axiosError.message || '';
      if (axiosError.code === 'ETIMEDOUT' || errorMessage.includes('timeout')) {
        throw new Error('Diar-service request timed out');
      }
      if (axiosError.response) {
        // Server responded with error status
        const status = axiosError.response.status;
        const errorData = axiosError.response.data as any;
        throw new Error(`Diar-service returned ${status}: ${errorData?.message || errorData?.error || errorMessage}`);
      }
      throw new Error(`Diar-service request failed: ${errorMessage}`);
    }
    // Re-throw other errors
    if (err instanceof Error) {
      throw err;
    }
    throw new Error('Unknown error occurred during diarization');
  } finally {
    // Clean up temporary file
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch (cleanupError) {
      console.warn(`Failed to delete temp file ${tempFilePath}:`, cleanupError);
    }
  }
}

/**
 * Extract speaker number from speaker label (e.g., "SPEAKER_00" -> 0)
 */
function getSpeakerNumber(speakerLabel: string): number {
  const match = speakerLabel.match(/SPEAKER_(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Match transcribed words to speaker segments based on timestamps
 */
export function matchWordsToSpeakers(
  words: Array<{ word: string; startOffset: string; endOffset: string }>,
  diarizationSegments: DiarizationSpeakerSegment[]
): Array<{ word: string; speakerTag: number; startOffset: string; endOffset: string }> {
  // Sort segments by start time for efficient lookup
  const sortedSegments = [...diarizationSegments].sort((a, b) => a.start - b.start);
  
  return words.map(word => {
    const wordStartTime = parseDuration(word.startOffset);
    const wordEndTime = parseDuration(word.endOffset);
    
    // Find segments that overlap with this word
    // A segment overlaps if: segment.start <= word.startTime < segment.end
    // or if the word spans across segment boundaries
    let bestSegment: DiarizationSpeakerSegment | null = null;
    let maxOverlap = 0;
    
    for (const segment of sortedSegments) {
      // Check if word overlaps with segment
      const overlapStart = Math.max(wordStartTime, segment.start);
      const overlapEnd = Math.min(wordEndTime, segment.end);
      
      if (overlapStart < overlapEnd) {
        const overlap = overlapEnd - overlapStart;
        if (overlap > maxOverlap) {
          maxOverlap = overlap;
          bestSegment = segment;
        }
      }
    }
    
    // If no segment found, try to find the closest segment
    if (!bestSegment && sortedSegments.length > 0) {
      // Find the segment with the smallest distance to word start
      let closestSegment = sortedSegments[0];
      let minDistance = Math.abs(wordStartTime - closestSegment.start);
      
      for (const segment of sortedSegments) {
        const distance = Math.min(
          Math.abs(wordStartTime - segment.start),
          Math.abs(wordStartTime - segment.end)
        );
        if (distance < minDistance) {
          minDistance = distance;
          closestSegment = segment;
        }
      }
      bestSegment = closestSegment;
    }
    
    const speakerTag = bestSegment ? getSpeakerNumber(bestSegment.speaker) : 0;
    
    return {
      word: word.word,
      speakerTag,
      startOffset: word.startOffset,
      endOffset: word.endOffset
    };
  });
}

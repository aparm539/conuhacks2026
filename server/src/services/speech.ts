import type { protos } from '@google-cloud/speech';
import { SpeechClient } from '@google-cloud/speech';
import { formatDuration } from '../utils/duration';
import { isWavFormat, validateAudioBuffer } from '../utils/audio';
import { getDiarization, matchWordsToSpeakers } from './diarization';
import type { DiarizationResponse } from '../types';
import {
  DEFAULT_ENCODING,
  DEFAULT_SAMPLE_RATE,
  SAMPLE_RATES,
} from '../config/constants';

/**
 * Process audio buffer with Google Cloud Speech API and return words with speaker tags
 * Runs transcription and diarization in parallel for faster processing
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  speechClient: SpeechClient
): Promise<Array<{ word: string; speakerTag: number; startOffset: string; endOffset: string }>> {
  // Validate audio buffer is not empty
  validateAudioBuffer(audioBuffer);

  // Google Cloud Speech API config WITHOUT diarization
  // Use auto-detection for encoding and sample rate for better compatibility
  const config: protos.google.cloud.speech.v1.IRecognitionConfig = {
    encoding: DEFAULT_ENCODING,
    sampleRateHertz: DEFAULT_SAMPLE_RATE,
    languageCode: 'en-US',
    enableWordTimeOffsets: true,
    alternativeLanguageCodes: [],
    useEnhanced: true,
  };

  const audioConfig: protos.google.cloud.speech.v1.IRecognitionAudio = {
    content: audioBuffer,
  };

  const request: protos.google.cloud.speech.v1.IRecognizeRequest = {
    config: config,
    audio: audioConfig,
  };

  // Start diarization in parallel with transcription for faster processing
  console.log('[TRANSCRIBE] Starting transcription and diarization in parallel...');
  const diarizationPromise = getDiarization(audioBuffer).catch(error => {
    console.error('[TRANSCRIBE] Diarization failed (will fallback):', error);
    return null;
  });

  console.log('[TRANSCRIBE] Calling Google Cloud Speech API...');
  const [response] = await speechClient.recognize(request);
  console.log('[TRANSCRIBE] Google Cloud Speech API response received. Results count:', response.results?.length || 0);

  if (!response.results || response.results.length === 0) {
    console.warn('[TRANSCRIBE] No results from Google Cloud Speech API, trying alternative configurations...');
    // If auto-detection failed, try with LINEAR16 at common sample rates
    console.log('Auto-detection failed, trying LINEAR16 at common sample rates...');
    
    for (const sampleRate of SAMPLE_RATES) {
      try {
        const altRequest: protos.google.cloud.speech.v1.IRecognizeRequest = {
          config: {
            encoding: DEFAULT_ENCODING,
            sampleRateHertz: sampleRate,
            languageCode: 'en-US',
            enableWordTimeOffsets: true,
            useEnhanced: true,
          },
          audio: audioConfig,
        };
        
      const [altResponse] = await speechClient.recognize(altRequest);
      if (altResponse.results && altResponse.results.length > 0) {
        console.log(`Success with LINEAR16/${sampleRate}Hz`);
        // Wait for diarization result that was started earlier
        const diarizationResult = await diarizationPromise;
        return processSpeechResponse(altResponse, diarizationResult);
      }
      } catch (altError) {
        console.log(`Failed with LINEAR16/${sampleRate}Hz:`, altError);
        continue;
      }
    }
    
    // If all attempts failed, provide helpful error message
    const formatHint = isWavFormat(audioBuffer) ? 'WAV file detected. ' : '';
    throw new Error(
      `No transcription results returned from Google Cloud Speech API. ${formatHint}Audio buffer size: ${audioBuffer.length} bytes. The audio format may not be supported. Please ensure the audio is in LINEAR16 PCM format (raw or WAV) at 16kHz, 44.1kHz, or 48kHz.`
    );
  }

  // Wait for diarization result that was started in parallel
  const diarizationResult = await diarizationPromise;
  return processSpeechResponse(response, diarizationResult);
}

/**
 * Process speech recognition response and add speaker tags from pre-fetched diarization result
 * Diarization is run in parallel with transcription for faster processing
 */
function processSpeechResponse(
  response: protos.google.cloud.speech.v1.IRecognizeResponse,
  diarizationResult: DiarizationResponse | null
): Array<{ word: string; speakerTag: number; startOffset: string; endOffset: string }> {
  // Extract words from the last result (speaker tags only appear in the final result)
  if (!response.results || response.results.length === 0) {
    throw new Error('No results found in transcription response');
  }
  const lastResult = response.results[response.results.length - 1];
  const alternative = lastResult.alternatives?.[0];
  
  if (!alternative || !alternative.words) {
    throw new Error('No words found in transcription results');
  }

  // Map words to include timestamps (without speaker tags yet)
  const wordsWithoutSpeakers = alternative.words.map((wordInfo: protos.google.cloud.speech.v1.IWordInfo) => ({
    word: wordInfo.word || '',
    startOffset: formatDuration(wordInfo.startTime),
    endOffset: formatDuration(wordInfo.endTime),
  }));

  // Use pre-fetched diarization result (already ran in parallel with transcription)
  let words: Array<{ word: string; speakerTag: number; startOffset: string; endOffset: string }>;
  
  if (diarizationResult) {
    console.log(`[TRANSCRIBE] Using diarization result: ${diarizationResult.segments.length} segments, ${diarizationResult.total_speakers} speakers`);
    // Match words to speaker segments
    words = matchWordsToSpeakers(wordsWithoutSpeakers, diarizationResult.segments);
  } else {
    // Fallback: return words without speaker tags (default to 0)
    console.warn('[TRANSCRIBE] Falling back to words without speaker tags');
    words = wordsWithoutSpeakers.map(w => ({
      ...w,
      speakerTag: 0
    }));
  }

  // Ensure words is always defined and is an array
  if (!words || !Array.isArray(words)) {
    console.error('[TRANSCRIBE] Words array is invalid, using fallback');
    words = wordsWithoutSpeakers.map(w => ({
      ...w,
      speakerTag: 0
    }));
  }

  return words;
}

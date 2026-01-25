/**
 * Audio format detection and validation utilities
 */

/**
 * Check if audio buffer is a WAV file by examining header
 */
export function isWavFormat(audioBuffer: Buffer): boolean {
  return (
    audioBuffer.length >= 12 &&
    audioBuffer.toString('ascii', 0, 4) === 'RIFF' &&
    audioBuffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

/**
 * Validate audio buffer is not empty
 */
export function validateAudioBuffer(audioBuffer: Buffer): void {
  if (audioBuffer.length === 0) {
    throw new Error('Audio buffer is empty. Please provide valid audio data.');
  }
}

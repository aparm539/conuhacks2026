import type { protos } from '@google-cloud/speech';

/**
 * Format a Duration protobuf object to a string (e.g., "1.100s" or "1s")
 */
export function formatDuration(
  duration: protos.google.protobuf.IDuration | null | undefined
): string {
  if (!duration) return '0s';
  
  const seconds = duration.seconds || 0;
  const nanos = duration.nanos || 0;
  const totalSeconds = Number(seconds) + (nanos / 1000000000);
  
  // Format with up to 3 decimal places if needed
  if (totalSeconds === Math.floor(totalSeconds)) {
    return `${totalSeconds}s`;
  }
  return `${totalSeconds.toFixed(3)}s`;
}

/**
 * Parse a duration string (e.g., "1.100s" or "1s") to seconds
 */
export function parseDuration(durationStr: string): number {
  const match = durationStr.match(/^(\d+(?:\.\d+)?)s?$/);
  if (!match) return 0;
  return parseFloat(match[1]);
}

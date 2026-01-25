import type { SpeakerSegment, ClassifiedSegment, SegmentClassification } from '../types';
import { VALID_CLASSIFICATIONS } from '../types';

/**
 * Validate a SpeakerSegment structure
 */
function validateSpeakerSegment(segment: any): segment is SpeakerSegment {
  return (
    typeof segment === 'object' &&
    segment !== null &&
    typeof segment.speakerTag === 'number' &&
    typeof segment.text === 'string' &&
    typeof segment.startTime === 'number' &&
    typeof segment.endTime === 'number'
  );
}

/**
 * Validate a ClassifiedSegment structure
 */
function validateClassifiedSegment(segment: any): segment is ClassifiedSegment {
  if (!validateSpeakerSegment(segment)) {
    return false;
  }
  // Type guard: segment is now known to be SpeakerSegment, check for classification
  const classified = segment as any;
  return (
    typeof classified.classification === 'string' &&
    VALID_CLASSIFICATIONS.includes(classified.classification as SegmentClassification)
  );
}

/**
 * Validate an array of SpeakerSegments
 */
export function validateSpeakerSegments(segments: any): segments is SpeakerSegment[] {
  if (!Array.isArray(segments)) {
    return false;
  }
  return segments.every(validateSpeakerSegment);
}

/**
 * Validate an array of ClassifiedSegments
 */
export function validateClassifiedSegments(segments: any): segments is ClassifiedSegment[] {
  if (!Array.isArray(segments)) {
    return false;
  }
  return segments.every(validateClassifiedSegment);
}

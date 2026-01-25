import { GoogleGenerativeAI } from '@google/generative-ai';
import type {
  SpeakerSegment,
  ClassifiedSegment,
  TransformedSegment,
  SegmentClassification,
  CandidateLocation,
} from '../types';
import {
  CONTEXT_SIZE,
  GEMINI_MODEL,
} from '../config/constants';
import { parseJsonResponse } from '../utils/jsonParser';
import { VALID_CLASSIFICATIONS } from '../types';

/**
 * Select the best locations for multiple comments using Gemini (batch processing)
 */
export async function selectCommentLocationsBatch(
  segments: Array<{
    commentText: string;
    classification: SegmentClassification;
    timestamp: number;
    fileName: string;
  }>,
  allCandidates: Array<CandidateLocation[]>,
  geminiClient: GoogleGenerativeAI
): Promise<Array<{ selectedIndex: number; rationale?: string }>> {
  console.log(`[Location Selection Batch] Processing ${segments.length} comment location selections`);

  if (segments.length === 0) {
    return [];
  }

  if (segments.length !== allCandidates.length) {
    throw new Error(`Mismatch: ${segments.length} segments but ${allCandidates.length} candidate arrays`);
  }

  // Build prompt for batch processing
  const segmentDescriptions = segments.map((segment, idx) => {
    const candidates = allCandidates[idx];
    const candidateDescriptions = candidates.map((candidate, candIdx) => {
      const codeContext = candidate.codeContext || '(No code context available)';
      return `  Candidate [${candIdx}]:
    - File: ${candidate.file}
    - Timestamp: ${candidate.timestamp.toFixed(2)}s
    - Cursor Line: ${candidate.cursorLine}
    - Visible Range: Lines ${candidate.visibleRange[0]}-${candidate.visibleRange[1]}
    - Symbols in View: ${candidate.symbolsInView.join(', ') || '(none)'}
    - Code Context:
${codeContext.split('\n').map(line => `      ${line}`).join('\n')}`;
    }).join('\n\n');

    return `Segment [${idx}]:
- Text: "${segment.commentText}"
- Classification: ${segment.classification}
- File: ${segment.fileName}
- Timestamp: ${segment.timestamp.toFixed(2)}s
- Candidates:
${candidateDescriptions}`;
  }).join('\n\n---\n\n');

  const prompt = `You are selecting the best locations for multiple code review comments in a codebase.

For each segment below, select the most appropriate location from its candidate locations. Consider:
- How relevant the comment is to the code context at each location
- Whether the comment addresses code that was visible when the comment was made
- The semantic relationship between the comment and the code symbols/functions visible
- Prefer locations where the code context matches the comment's intent

Segments to process:
${segmentDescriptions}

Return a JSON array with exactly ${segments.length} element(s), one for each segment in order. Each element must be a JSON object with:
- "selectedIndex": The index (0-based) of the best candidate location for that segment
- "rationale": A brief explanation (1-2 sentences) of why this location was chosen (optional)

Example response for 2 segments:
[
  {
    "selectedIndex": 2,
    "rationale": "This location is best because the comment addresses the error handling function that was visible at this timestamp."
  },
  {
    "selectedIndex": 0,
    "rationale": "The comment relates to the function definition visible at the cursor position."
  }
]

Return ONLY the JSON array, no other text, no markdown, no explanations.

Selections:`;

  console.log(`[Location Selection Batch] Calling Gemini API with prompt (${prompt.length} chars)...`);
  const model = geminiClient.getGenerativeModel({ model: GEMINI_MODEL });
  const result = await model.generateContent(prompt);
  const response = await result.response;
  const text = response.text();
  console.log(`[Location Selection Batch] Received response from Gemini (${text.length} chars)`);

  // Parse JSON response
  const selections = parseJsonResponse<Array<{ selectedIndex: number; rationale?: string }>>(text);
  console.log(`[Location Selection Batch] Parsed JSON from response`);

  // Validate response
  if (!Array.isArray(selections)) {
    throw new Error(`Expected array, got ${typeof selections}`);
  }

  if (selections.length !== segments.length) {
    throw new Error(`Expected ${segments.length} selections, got ${selections.length}`);
  }

  // Validate each selection
  for (let i = 0; i < selections.length; i++) {
    const selection = selections[i];
    const candidates = allCandidates[i];

    if (typeof selection.selectedIndex !== 'number') {
      throw new Error(`Invalid selectedIndex at index ${i}: expected number, got ${typeof selection.selectedIndex}`);
    }

    if (selection.selectedIndex < 0 || selection.selectedIndex >= candidates.length) {
      throw new Error(`Selected index ${selection.selectedIndex} at segment ${i} is out of range (0-${candidates.length - 1})`);
    }
  }

  console.log(`[Location Selection Batch] ✓ Successfully processed ${selections.length} location selections`);
  return selections;
}

/**
 * Unified processing: classify, split, and transform segments in a single Gemini call
 * This reduces API calls from ~10+ to 1-2 per audio file
 */
export async function processSegmentsUnified(
  segments: SpeakerSegment[],
  geminiClient: GoogleGenerativeAI
): Promise<TransformedSegment[]> {
  if (segments.length === 0) {
    return [];
  }

  // Use a larger batch size for unified processing since we're doing more work per call
  const BATCH_SIZE_UNIFIED = 10;
  const results: TransformedSegment[] = [];

  for (let i = 0; i < segments.length; i += BATCH_SIZE_UNIFIED) {
    const batchEnd = Math.min(i + BATCH_SIZE_UNIFIED, segments.length);
    const batch = segments.slice(i, batchEnd);

    // Get context segments
    const contextBefore = segments.slice(Math.max(0, i - CONTEXT_SIZE), i);
    const contextAfter = segments.slice(batchEnd, Math.min(segments.length, batchEnd + CONTEXT_SIZE));
    const allSegments = [...contextBefore, ...batch, ...contextAfter];
    const segmentStartIndex = contextBefore.length;
    const segmentEndIndex = segmentStartIndex + batch.length;

    // Build unified prompt that does classification, splitting, and transformation
    const segmentsText = batch
      .map((seg, idx) => {
        const globalIdx = segmentStartIndex + idx;
        return `[${globalIdx}] Speaker ${seg.speakerTag}: "${seg.text}" (${seg.startTime.toFixed(2)}s - ${seg.endTime.toFixed(2)}s)`;
      })
      .join('\n');

    const contextText = allSegments.length > batch.length
      ? `\n\nContext (for reference only):\n${allSegments
          .map((seg, idx) => `[${idx}] Speaker ${seg.speakerTag}: "${seg.text}"`)
          .join('\n')}`
      : '';

    const prompt = `You are processing code review speech segments through a complete pipeline: classification, splitting, and transformation.

STEP 1 - CLASSIFICATION:
Classify each segment (indices ${segmentStartIndex} to ${segmentEndIndex - 1}) into exactly one category:
- Ignore: Off-topic, filler words, or not relevant to code review
- Question: Asking about how something works or why it was done
- Concern: Expressing worry about potential issues or problems
- Suggestion: Proposing improvements or alternatives
- Style: Comments about code style, readability, or formatting

STEP 2 - SPLITTING:
For each segment, determine if it should be split into multiple comments:
- Split if: discusses multiple distinct topics, would be clearer as multiple focused comments, topics are sufficiently different
- Keep if: single coherent thought, parts are closely related, splitting would fragment a cohesive comment
- Mark as "duplicate" if: expresses the same meaning as another segment (compare against all segments including context)

STEP 3 - TRANSFORMATION:
For each resulting segment (after splitting), transform the raw speech text into polished, professional code review comments:
- Remove filler words ("um", "uh", "like", "you know", "I mean")
- Fix grammar and spelling errors
- Make language professional, clear, and concise
- Preserve original meaning and intent
- Keep appropriate for code reviews

Segments to process:${segmentsText}${contextText}

Return a JSON array with exactly ${batch.length} element(s), one for each input segment in order. Each element must be one of:
- An array of objects (if the segment should be split into multiple comments)
- An object (if the segment should remain as one comment and is not a duplicate)
- null (if the segment is a duplicate and should be removed)

Each object must have:
- "classification": one of "Ignore", "Question", "Concern", "Suggestion", "Style"
- "transformedText": the polished, professional version of the text
- "speakerTag": the speaker tag number (preserve from input)
- "startTime": start timestamp in seconds (preserve from input, or calculate proportionally for splits)
- "endTime": end timestamp in seconds (preserve from input, or calculate proportionally for splits)

IMPORTANT:
- Filter out "Ignore" segments by returning null for them (don't include them in the output)
- For split segments, return an array of objects (one per split part) with proportional timestamps
- For duplicates, return null
- Preserve speakerTag, startTime, and endTime from the original segment

Example for 2 segments:
Input:
[0] Speaker 1: "um like this function could maybe be better and also we should add error handling here"
[1] Speaker 1: "how does this work?"

Output (JSON only):
[
  [
    {"classification": "Suggestion", "transformedText": "This function could be improved", "speakerTag": 1, "startTime": 0.0, "endTime": 2.5},
    {"classification": "Suggestion", "transformedText": "Consider adding error handling here", "speakerTag": 1, "startTime": 2.5, "endTime": 5.0}
  ],
  {"classification": "Question", "transformedText": "How does this work?", "speakerTag": 1, "startTime": 5.0, "endTime": 7.0}
]

Return ONLY the JSON array, no other text, no markdown, no explanations.`;

    // Call Gemini API
    console.log(`[Unified Processing] Processing batch ${i / BATCH_SIZE_UNIFIED + 1}, segments ${i} to ${batchEnd - 1}`);
    const model = geminiClient.getGenerativeModel({ model: GEMINI_MODEL });
    
    let result;
    try {
      result = await model.generateContent(prompt);
    } catch (apiError) {
      console.error('[Unified Processing] Gemini API call failed:', apiError);
      throw apiError;
    }
    
    const response = await result.response;
    const text = response.text();
    console.log(`[Unified Processing] Received response (${text.length} chars)`);

    // Parse JSON response
    let processedResults: (TransformedSegment | TransformedSegment[] | null)[];
    try {
      processedResults = parseJsonResponse<(TransformedSegment | TransformedSegment[] | null)[]>(text);
    } catch (error) {
      console.error('Failed to parse Gemini unified processing response. Raw text:', text);
      console.error('Parse error:', error);
      throw new Error(`Failed to parse unified processing response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Validate response
    if (!Array.isArray(processedResults)) {
      throw new Error(`Expected array, got ${typeof processedResults}`);
    }

    if (processedResults.length !== batch.length) {
      throw new Error(`Expected ${batch.length} results, got ${processedResults.length}`);
    }

    // Flatten results (handle splits and filter nulls/duplicates)
    for (let j = 0; j < processedResults.length; j++) {
      const result = processedResults[j];

      if (result === null) {
        // Duplicate or Ignore segment - skip it
        continue;
      }

      if (Array.isArray(result)) {
        // Split segment - add all parts
        for (const part of result) {
          // Validate part structure
          if (!part || typeof part !== 'object') {
            console.warn(`[Unified Processing] Invalid split part at index ${j}, skipping`);
            continue;
          }
          if (!part.classification || !part.transformedText || typeof part.speakerTag !== 'number' || 
              typeof part.startTime !== 'number' || typeof part.endTime !== 'number') {
            console.warn(`[Unified Processing] Invalid split part structure at index ${j}, skipping`);
            continue;
          }
          if (!VALID_CLASSIFICATIONS.includes(part.classification)) {
            console.warn(`[Unified Processing] Invalid classification "${part.classification}" at index ${j}, skipping`);
            continue;
          }
          // Filter out Ignore segments
          if (part.classification === 'Ignore') {
            continue;
          }
          results.push(part);
        }
      } else {
        // Single segment - validate and add
        if (!result.classification || !result.transformedText || typeof result.speakerTag !== 'number' ||
            typeof result.startTime !== 'number' || typeof result.endTime !== 'number') {
          console.warn(`[Unified Processing] Invalid result structure at index ${j}, skipping`);
          continue;
        }
        if (!VALID_CLASSIFICATIONS.includes(result.classification)) {
          console.warn(`[Unified Processing] Invalid classification "${result.classification}" at index ${j}, skipping`);
          continue;
        }
        // Filter out Ignore segments
        if (result.classification === 'Ignore') {
          continue;
        }
        results.push(result);
      }
    }
  }

  console.log(`[Unified Processing] Processed ${segments.length} segments into ${results.length} transformed segments`);
  return results;
}

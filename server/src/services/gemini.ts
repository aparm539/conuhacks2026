import { GoogleGenerativeAI } from '@google/generative-ai';
import type {
  SpeakerSegment,
  ClassifiedSegment,
  TransformedSegment,
  SegmentClassification,
  CandidateLocation,
} from '../types';
import {
  BATCH_SIZE_CLASSIFY,
  BATCH_SIZE_TRANSFORM,
  BATCH_SIZE_SPLIT,
  CONTEXT_SIZE,
  GEMINI_MODEL,
} from '../config/constants';
import { parseJsonArray } from '../utils/jsonParser';
import { VALID_CLASSIFICATIONS } from '../types';

/**
 * Classify a batch of segments with surrounding context
 */
export async function classifySegmentsBatch(
  segments: SpeakerSegment[],
  contextBefore: SpeakerSegment[],
  contextAfter: SpeakerSegment[],
  geminiClient: GoogleGenerativeAI
): Promise<SegmentClassification[]> {
  // Combine context and segments
  const allSegments = [...contextBefore, ...segments, ...contextAfter];
  const segmentStartIndex = contextBefore.length;
  const segmentEndIndex = segmentStartIndex + segments.length;

  // Build prompt
  const segmentsText = allSegments
    .map((seg, idx) => `[${idx}] Speaker ${seg.speakerTag}: "${seg.text}"`)
    .join('\n');

  const prompt = `You are classifying spoken segments from a code review discussion. Each segment should be classified into exactly one of these categories:

- Ignore: Off-topic, filler words, or not relevant to code review
- Question: Asking about how something works or why it was done
- Concern: Expressing worry about potential issues or problems
- Suggestion: Proposing improvements or alternatives
- Style: Comments about code style, readability, or formatting

Segments to classify (indices ${segmentStartIndex} to ${segmentEndIndex - 1}):
${segmentsText}

Return a JSON array with classifications for indices ${segmentStartIndex} to ${segmentEndIndex - 1} only, in order. Each element should be one of: "Ignore", "Question", "Concern", "Suggestion", "Style".

Example format: ["Question", "Concern", "Suggestion"]

Classifications:`;

  const model = geminiClient.getGenerativeModel({ model: GEMINI_MODEL });
  const result = await model.generateContent(prompt);
  const response = await result.response;
  const text = response.text();

  // Parse JSON response
  let classifications: string[];
  try {
    // Extract JSON from response (might have markdown code blocks)
    const jsonMatch = text.match(/\[.*?\]/s);
    if (jsonMatch) {
      classifications = JSON.parse(jsonMatch[0]);
    } else {
      classifications = JSON.parse(text);
    }
  } catch (error) {
    console.error('Failed to parse Gemini response:', text);
    throw new Error(`Failed to parse classification response: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Validate classifications
  if (!Array.isArray(classifications) || classifications.length !== segments.length) {
    throw new Error(`Expected ${segments.length} classifications, got ${classifications.length}`);
  }

  // Validate each classification
  for (let i = 0; i < classifications.length; i++) {
    if (!VALID_CLASSIFICATIONS.includes(classifications[i] as SegmentClassification)) {
      throw new Error(`Invalid classification at index ${i}: ${classifications[i]}`);
    }
  }

  return classifications as SegmentClassification[];
}

/**
 * Classify segments sequentially in batches with context
 */
export async function classifySegmentsSequentially(
  segments: SpeakerSegment[],
  geminiClient: GoogleGenerativeAI
): Promise<ClassifiedSegment[]> {
  if (segments.length === 0) {
    return [];
  }

  const results: ClassifiedSegment[] = [];

  for (let i = 0; i < segments.length; i += BATCH_SIZE_CLASSIFY) {
    const batchEnd = Math.min(i + BATCH_SIZE_CLASSIFY, segments.length);
    const batch = segments.slice(i, batchEnd);

    // Get context segments
    const contextBefore = segments.slice(Math.max(0, i - CONTEXT_SIZE), i);
    const contextAfter = segments.slice(batchEnd, Math.min(segments.length, batchEnd + CONTEXT_SIZE));

    // Classify batch
    const classifications = await classifySegmentsBatch(batch, contextBefore, contextAfter, geminiClient);

    // Combine segments with classifications
    for (let j = 0; j < batch.length; j++) {
      results.push({
        ...batch[j],
        classification: classifications[j],
      });
    }
  }

  return results;
}

/**
 * Transform a batch of classified segments into polished review comments
 */
export async function transformSegmentsBatch(
  segments: ClassifiedSegment[],
  contextBefore: ClassifiedSegment[],
  contextAfter: ClassifiedSegment[],
  geminiClient: GoogleGenerativeAI
): Promise<string[]> {
  // Combine context and segments
  const allSegments = [...contextBefore, ...segments, ...contextAfter];
  const segmentStartIndex = contextBefore.length;
  const segmentEndIndex = segmentStartIndex + segments.length;

  // Build prompt with segments and their classifications
  const segmentsText = segments
    .map((seg, idx) => {
      const globalIdx = segmentStartIndex + idx;
      return `[${globalIdx}] [${seg.classification}] "${seg.text}"`;
    })
    .join('\n');

  const contextText = allSegments.length > segments.length
    ? `\n\nContext (for reference only):\n${allSegments
        .map((seg, idx) => {
          const classification = 'classification' in seg ? `[${seg.classification}]` : '';
          return `[${idx}] ${classification} "${seg.text}"`;
        })
        .join('\n')}`
    : '';

  const prompt = `You are transforming raw spoken code review comments into polished, professional review comments.

For each segment below, transform the raw speech text into a polished, professional code review comment. Your transformations should:

- Remove filler words and verbal tics ("um", "uh", "like", "you know", "I mean")
- Fix grammar and spelling errors
- Make the language professional, clear, and concise
- Preserve the original meaning and intent
- Keep it appropriate for code reviews
- Maintain the classification context (Question, Concern, Suggestion, Style)

Segments to transform (indices ${segmentStartIndex} to ${segmentEndIndex - 1}):${segmentsText}${contextText}

Return a JSON array with transformed text for indices ${segmentStartIndex} to ${segmentEndIndex - 1} only, in order. Each element should be the polished version of the corresponding segment's text.

Example:
Input: ["um like this function could maybe be better", "I think we should add error handling here"]
Output: ["This function could be improved", "Consider adding error handling here"]

Transformed comments:`;

  const model = geminiClient.getGenerativeModel({ model: GEMINI_MODEL });
  const result = await model.generateContent(prompt);
  const response = await result.response;
  const text = response.text();

  // Parse JSON response
  let transformedTexts: string[];
  try {
    // Extract JSON from response (might have markdown code blocks)
    const jsonMatch = text.match(/\[.*?\]/s);
    if (jsonMatch) {
      transformedTexts = JSON.parse(jsonMatch[0]);
    } else {
      transformedTexts = JSON.parse(text);
    }
  } catch (error) {
    console.error('Failed to parse Gemini transformation response:', text);
    throw new Error(`Failed to parse transformation response: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Validate response
  if (!Array.isArray(transformedTexts) || transformedTexts.length !== segments.length) {
    throw new Error(`Expected ${segments.length} transformed texts, got ${transformedTexts.length}`);
  }

  // Validate each transformed text is a string
  for (let i = 0; i < transformedTexts.length; i++) {
    if (typeof transformedTexts[i] !== 'string') {
      throw new Error(`Invalid transformed text at index ${i}: expected string, got ${typeof transformedTexts[i]}`);
    }
  }

  return transformedTexts;
}

/**
 * Transform classified segments sequentially in batches with context
 * Filters out Ignore segments and only transforms non-Ignore segments
 */
export async function transformSegmentsSequentially(
  classifiedSegments: ClassifiedSegment[],
  geminiClient: GoogleGenerativeAI
): Promise<TransformedSegment[]> {
  // Filter out Ignore segments - they won't be transformed
  const segmentsToTransform = classifiedSegments.filter(seg => seg.classification !== 'Ignore');
  
  if (segmentsToTransform.length === 0) {
    // Return empty array if all segments are Ignore
    return [];
  }

  const results: TransformedSegment[] = [];

  // Create a map to track original indices for context lookup
  const originalIndices = new Map<ClassifiedSegment, number>();
  classifiedSegments.forEach((seg, idx) => {
    originalIndices.set(seg, idx);
  });

  for (let i = 0; i < segmentsToTransform.length; i += BATCH_SIZE_TRANSFORM) {
    const batchEnd = Math.min(i + BATCH_SIZE_TRANSFORM, segmentsToTransform.length);
    const batch = segmentsToTransform.slice(i, batchEnd);

    // Get context segments from the original array (including Ignore segments for context)
    const batchStartOriginalIdx = originalIndices.get(batch[0])!;
    const batchEndOriginalIdx = originalIndices.get(batch[batch.length - 1])!;
    
    const contextBefore = classifiedSegments.slice(
      Math.max(0, batchStartOriginalIdx - CONTEXT_SIZE),
      batchStartOriginalIdx
    );
    const contextAfter = classifiedSegments.slice(
      batchEndOriginalIdx + 1,
      Math.min(classifiedSegments.length, batchEndOriginalIdx + 1 + CONTEXT_SIZE)
    );

    // Transform batch
    const transformedTexts = await transformSegmentsBatch(batch, contextBefore, contextAfter, geminiClient);

    // Combine segments with transformed text
    for (let j = 0; j < batch.length; j++) {
      results.push({
        ...batch[j],
        transformedText: transformedTexts[j],
      });
    }
  }

  return results;
}

/**
 * Split a batch of segments based on topic and context
 * Returns an array of split decisions: each element is either "keep" or an array of split text parts
 */
export async function splitSegmentsBatch(
  segments: ClassifiedSegment[],
  contextBefore: ClassifiedSegment[],
  contextAfter: ClassifiedSegment[],
  geminiClient: GoogleGenerativeAI
): Promise<(string | string[])[]> {
  // Combine context and segments
  const allSegments = [...contextBefore, ...segments, ...contextAfter];
  const segmentStartIndex = contextBefore.length;
  const segmentEndIndex = segmentStartIndex + segments.length;

  // Build prompt with segments
  const segmentsText = segments
    .map((seg, idx) => {
      const globalIdx = segmentStartIndex + idx;
      return `[${globalIdx}] [${seg.classification}] Speaker ${seg.speakerTag}: "${seg.text}" (${seg.startTime.toFixed(2)}s - ${seg.endTime.toFixed(2)}s)`;
    })
    .join('\n');

  const contextText = allSegments.length > segments.length
    ? `\n\nContext (for reference only):\n${allSegments
        .map((seg, idx) => {
          const classification = 'classification' in seg ? `[${seg.classification}]` : '';
          return `[${idx}] ${classification} Speaker ${seg.speakerTag}: "${seg.text}"`;
        })
        .join('\n')}`
    : '';

  const prompt = `You are analyzing code review speech segments to determine if they should be split into multiple comments and to identify duplicate segments.

A segment should be split if:
- It discusses multiple distinct topics (e.g., different functions, different concerns, different code areas)
- It would be clearer as multiple focused comments rather than one long comment
- The topics are sufficiently different that separate comments would improve code review clarity
- The segment is very long and covers multiple unrelated points

A segment should NOT be split if:
- It's a single coherent thought or topic
- The parts are closely related and belong together
- Splitting would fragment a cohesive comment
- The segment is already appropriately sized

IMPORTANT: Duplicate Detection
- Compare each segment (indices ${segmentStartIndex} to ${segmentEndIndex - 1}) against ALL other segments (including context segments)
- If a segment expresses the same or very similar meaning as another segment, mark it as "duplicate"
- Mark duplicates even if the wording is slightly different but the meaning is the same
- Keep the FIRST occurrence and mark subsequent duplicates
- Only mark as "duplicate" if the segments are truly redundant, not just related

For each segment below (indices ${segmentStartIndex} to ${segmentEndIndex - 1}), analyze:
1. Whether it should be split (return array of parts) or kept as-is (return "keep")
2. Whether it is a duplicate of another segment (return "duplicate")

Segments to analyze:${segmentsText}${contextText}

Return ONLY a valid JSON array with exactly ${segments.length} element(s), one for each segment in order. Each element must be one of:
- The string "keep" (if the segment should remain as one comment and is not a duplicate)
- An array of strings (if the segment should be split into multiple parts and is not a duplicate)
- The string "duplicate" (if the segment is a duplicate of another segment and should be removed)

IMPORTANT: Return ONLY the JSON array, no other text, no markdown, no explanations.

Example for 3 segments:
Input:
[0] [Suggestion] Speaker 1: "This function could be improved and also we should add error handling here"
[1] [Question] Speaker 1: "How does this work?"
[2] [Suggestion] Speaker 1: "This function could be improved"

Output (JSON only):
[["This function could be improved", "Also we should add error handling here"], "keep", "duplicate"]

Now return the JSON array for the segments above:`;

  const model = geminiClient.getGenerativeModel({ model: GEMINI_MODEL });
  const result = await model.generateContent(prompt);
  const response = await result.response;
  const text = response.text();

  // Parse JSON response using the utility function
  let splitDecisions: (string | string[])[];
  try {
    splitDecisions = parseJsonArray<(string | string[])>(text, segments.length);
  } catch (error) {
    console.error('Failed to parse Gemini split response. Raw text:', text);
    console.error('Parse error:', error);
    throw new Error(`Failed to parse split response: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Log what we parsed for debugging
  if (segments.length === 1) {
    console.log(`[Split] Parsed response for 1 segment:`, JSON.stringify(splitDecisions));
  }

  // Validate response
  if (!Array.isArray(splitDecisions)) {
    throw new Error(`Expected array, got ${typeof splitDecisions}`);
  }
  
  if (splitDecisions.length !== segments.length) {
    throw new Error(`Expected ${segments.length} split decisions, got ${splitDecisions.length}`);
  }

  // Validate each decision
  for (let i = 0; i < splitDecisions.length; i++) {
    const decision = splitDecisions[i];
    if (decision === 'keep' || decision === 'duplicate') {
      continue;
    }
    if (!Array.isArray(decision) || decision.length === 0) {
      throw new Error(`Invalid split decision at index ${i}: expected "keep", "duplicate", or array of strings, got ${typeof decision}`);
    }
    for (let j = 0; j < decision.length; j++) {
      if (typeof decision[j] !== 'string') {
        throw new Error(`Invalid split part at index ${i}[${j}]: expected string, got ${typeof decision[j]}`);
      }
    }
  }

  return splitDecisions;
}

/**
 * Split segments sequentially in batches with context
 * Splits long segments into multiple segments when appropriate
 */
export async function splitSegmentsSequentially(
  classifiedSegments: ClassifiedSegment[],
  geminiClient: GoogleGenerativeAI
): Promise<ClassifiedSegment[]> {
  if (classifiedSegments.length === 0) {
    return [];
  }

  const results: ClassifiedSegment[] = [];
  let totalDuplicatesFiltered = 0;

  for (let i = 0; i < classifiedSegments.length; i += BATCH_SIZE_SPLIT) {
    const batchEnd = Math.min(i + BATCH_SIZE_SPLIT, classifiedSegments.length);
    const batch = classifiedSegments.slice(i, batchEnd);

    // Get context segments
    const contextBefore = classifiedSegments.slice(Math.max(0, i - CONTEXT_SIZE), i);
    const contextAfter = classifiedSegments.slice(batchEnd, Math.min(classifiedSegments.length, batchEnd + CONTEXT_SIZE));

    // Get split decisions
    const splitDecisions = await splitSegmentsBatch(batch, contextBefore, contextAfter, geminiClient);

    // Process each segment based on split decision
    let batchDuplicatesFiltered = 0;
    for (let j = 0; j < batch.length; j++) {
      const segment = batch[j];
      const decision = splitDecisions[j];

      if (decision === 'duplicate') {
        // Skip creating segment - it's a duplicate
        batchDuplicatesFiltered++;
        totalDuplicatesFiltered++;
        console.log(`[Deduplication] LLM marked segment as duplicate: "${segment.text.substring(0, 50)}${segment.text.length > 50 ? '...' : ''}"`);
      } else if (decision === 'keep') {
        // Keep segment as-is
        results.push(segment);
      } else if (Array.isArray(decision)) {
        // Split segment into multiple segments
        const splitParts = decision as string[];
        const totalTextLength = segment.text.length;
        const segmentDuration = segment.endTime - segment.startTime;

        // Calculate proportional timestamps for each split part
        let currentTime = segment.startTime;
        
        for (let k = 0; k < splitParts.length; k++) {
          const part = splitParts[k].trim();
          if (!part) {
            continue; // Skip empty parts
          }

          // Estimate time for this part based on text length proportion
          // Use a simple heuristic: assume time is proportional to text length
          const partLength = part.length;
          const partDuration = (partLength / totalTextLength) * segmentDuration;
          const partEndTime = currentTime + partDuration;

          // Create new segment with split text
          results.push({
            speakerTag: segment.speakerTag,
            text: part,
            startTime: currentTime,
            endTime: partEndTime,
            classification: segment.classification,
          });

          currentTime = partEndTime;
        }
      }
    }

    if (batchDuplicatesFiltered > 0) {
      console.log(`[Deduplication] Filtered ${batchDuplicatesFiltered} duplicate segment(s) from batch of ${batch.length} segments`);
    }
  }

  if (totalDuplicatesFiltered > 0) {
    console.log(`[Deduplication] Total: Filtered ${totalDuplicatesFiltered} duplicate segment(s) from ${classifiedSegments.length} total segments`);
  }

  return results;
}

/**
 * Select the best location for a comment using Gemini
 */
export async function selectCommentLocation(
  commentText: string,
  classification: SegmentClassification,
  candidates: CandidateLocation[],
  fileName: string,
  geminiClient: GoogleGenerativeAI
): Promise<{ selectedIndex: number; rationale?: string }> {
  console.log(`[Location Selection] Starting location selection for comment: "${commentText.substring(0, 50)}${commentText.length > 50 ? '...' : ''}"`);
  console.log(`[Location Selection] Classification: ${classification}, File: ${fileName}, Candidates: ${candidates.length}`);

  if (candidates.length === 0) {
    console.error('[Location Selection] ERROR: No candidate locations provided');
    throw new Error('No candidate locations provided');
  }

  // Log candidate details
  console.log(`[Location Selection] Candidate locations:`);
  candidates.forEach((candidate, idx) => {
    console.log(`  [${idx}] File: ${candidate.file}, Timestamp: ${candidate.timestamp.toFixed(2)}s, Cursor: ${candidate.cursorLine}, Symbols: ${candidate.symbolsInView.length}`);
  });

  // Build candidate descriptions
  const candidateDescriptions = candidates.map((candidate, idx) => {
    const codeContext = candidate.codeContext || '(No code context available)';
    return `Candidate [${idx}]:
- File: ${candidate.file}
- Timestamp: ${candidate.timestamp.toFixed(2)}s
- Cursor Line: ${candidate.cursorLine}
- Visible Range: Lines ${candidate.visibleRange[0]}-${candidate.visibleRange[1]}
- Symbols in View: ${candidate.symbolsInView.join(', ') || '(none)'}
- Code Context:
${codeContext}`;
  }).join('\n\n');

  const prompt = `You are selecting the best location for a code review comment in a codebase.

Comment Details:
- Text: "${commentText}"
- Classification: ${classification}
- File: ${fileName}

Your task is to select the most appropriate location from the candidate locations below. Consider:
- How relevant the comment is to the code context at each location
- Whether the comment addresses code that was visible when the comment was made
- The semantic relationship between the comment and the code symbols/functions visible
- Prefer locations where the code context matches the comment's intent

Candidate Locations:
${candidateDescriptions}

Return a JSON object with:
- "selectedIndex": The index (0-based) of the best candidate location
- "rationale": A brief explanation (1-2 sentences) of why this location was chosen

Example response:
{
  "selectedIndex": 2,
  "rationale": "This location is best because the comment addresses the error handling function that was visible at this timestamp."
}

Selection:`;

  console.log(`[Location Selection] Calling Gemini API with prompt (${prompt.length} chars)...`);
  const model = geminiClient.getGenerativeModel({ model: GEMINI_MODEL });
  const result = await model.generateContent(prompt);
  const response = await result.response;
  const text = response.text();
  console.log(`[Location Selection] Received response from Gemini (${text.length} chars)`);

  // Parse JSON response
  let selection: { selectedIndex: number; rationale?: string };
  try {
    // Extract JSON from response (might have markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      selection = JSON.parse(jsonMatch[0]);
      console.log(`[Location Selection] Parsed JSON from response (extracted from markdown)`);
    } else {
      selection = JSON.parse(text);
      console.log(`[Location Selection] Parsed JSON directly from response`);
    }
  } catch (error) {
    console.error('[Location Selection] ERROR: Failed to parse Gemini response');
    console.error('[Location Selection] Raw response:', text);
    throw new Error(`Failed to parse location selection response: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Validate response
  if (typeof selection.selectedIndex !== 'number') {
    console.error(`[Location Selection] ERROR: Invalid selectedIndex type: ${typeof selection.selectedIndex}`);
    throw new Error(`Invalid selectedIndex: expected number, got ${typeof selection.selectedIndex}`);
  }

  if (selection.selectedIndex < 0 || selection.selectedIndex >= candidates.length) {
    console.error(`[Location Selection] ERROR: Selected index ${selection.selectedIndex} out of range (0-${candidates.length - 1})`);
    throw new Error(`Selected index ${selection.selectedIndex} is out of range (0-${candidates.length - 1})`);
  }

  const selectedCandidate = candidates[selection.selectedIndex];
  console.log(`[Location Selection] ✓ Selected candidate [${selection.selectedIndex}]:`);
  console.log(`  File: ${selectedCandidate.file}`);
  console.log(`  Timestamp: ${selectedCandidate.timestamp.toFixed(2)}s`);
  console.log(`  Cursor Line: ${selectedCandidate.cursorLine}`);
  if (selection.rationale) {
    console.log(`  Rationale: ${selection.rationale}`);
  }

  return {
    selectedIndex: selection.selectedIndex,
    rationale: selection.rationale
  };
}

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
  let selections: Array<{ selectedIndex: number; rationale?: string }>;
  try {
    // Extract JSON from response (might have markdown code blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      selections = JSON.parse(jsonMatch[0]);
      console.log(`[Location Selection Batch] Parsed JSON from response (extracted from markdown)`);
    } else {
      selections = JSON.parse(text);
      console.log(`[Location Selection Batch] Parsed JSON directly from response`);
    }
  } catch (error) {
    console.error('[Location Selection Batch] ERROR: Failed to parse Gemini response');
    console.error('[Location Selection Batch] Raw response:', text);
    throw new Error(`Failed to parse batch location selection response: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

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

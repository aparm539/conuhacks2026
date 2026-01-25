/**
 * Gemini service for processing speech segments
 * Handles classification, splitting, and transformation of spoken code review comments
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type {
    SpeakerSegment,
    ClassifiedSegment,
    TransformedSegment,
    SegmentClassification,
    CandidateLocation,
    LocationSelection,
} from '../types';
import { VALID_CLASSIFICATIONS } from '../types';
import { parseJsonArray } from '../utils/jsonParser';

// Configuration constants
const BATCH_SIZE_CLASSIFY = 7;
const BATCH_SIZE_TRANSFORM = 7;
const BATCH_SIZE_SPLIT = 5;
const CONTEXT_SIZE = 2;
const GEMINI_MODEL = 'gemini-2.0-flash';

// Gemini client (lazily initialized)
let geminiClient: GoogleGenerativeAI | null = null;
let cachedApiKey: string | null = null;

// Function to get API key from secret storage (set by extension)
let getApiKeyFromSecrets: (() => Promise<string | undefined>) | null = null;

/**
 * Initialize the Gemini service with a function to retrieve the API key from secrets
 * This must be called during extension activation
 */
export function initializeGeminiService(getApiKey: () => Promise<string | undefined>): void {
    getApiKeyFromSecrets = getApiKey;
    // Reset cached client when re-initializing
    geminiClient = null;
    cachedApiKey = null;
}

/**
 * Reset the Gemini client (call after API key changes)
 */
export function resetGeminiClient(): void {
    geminiClient = null;
    cachedApiKey = null;
}

/**
 * Get or create the Gemini client
 */
async function getGeminiClientAsync(): Promise<GoogleGenerativeAI> {
    // Check if we need to refresh the client (API key changed)
    let apiKey: string | undefined;
    
    if (getApiKeyFromSecrets) {
        apiKey = await getApiKeyFromSecrets();
    }

    // If API key changed, reset the client
    if (apiKey && apiKey !== cachedApiKey) {
        geminiClient = null;
        cachedApiKey = apiKey;
    }

    if (geminiClient) {
        return geminiClient;
    }

    if (!apiKey) {
        throw new Error('Gemini API key not configured. Use the "PR Notes: Set Gemini API Key" command to set your API key.');
    }

    geminiClient = new GoogleGenerativeAI(apiKey);
    cachedApiKey = apiKey;
    return geminiClient;
}

/**
 * Classify a batch of segments with surrounding context
 */
async function classifySegmentsBatch(
    segments: SpeakerSegment[],
    contextBefore: SpeakerSegment[],
    contextAfter: SpeakerSegment[]
): Promise<SegmentClassification[]> {
    const client = await getGeminiClientAsync();
    
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

    const model = client.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    let classifications: string[];
    try {
        classifications = parseJsonArray<string>(text, segments.length);
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
 * Classify segments in parallel batches with context
 */
export async function classifySegmentsInBatches(
    segments: SpeakerSegment[]
): Promise<ClassifiedSegment[]> {
    if (segments.length === 0) {
        return [];
    }

    const batchPromises: Promise<{ batchIndex: number; batch: SpeakerSegment[]; classifications: SegmentClassification[] }>[] = [];

    for (let i = 0; i < segments.length; i += BATCH_SIZE_CLASSIFY) {
        const batchEnd = Math.min(i + BATCH_SIZE_CLASSIFY, segments.length);
        const batch = segments.slice(i, batchEnd);
        const batchIndex = i;

        const contextBefore = segments.slice(Math.max(0, i - CONTEXT_SIZE), i);
        const contextAfter = segments.slice(batchEnd, Math.min(segments.length, batchEnd + CONTEXT_SIZE));

        const batchPromise = classifySegmentsBatch(batch, contextBefore, contextAfter)
            .then(classifications => ({ batchIndex, batch, classifications }));

        batchPromises.push(batchPromise);
    }

    console.log(`[Classify] Processing ${batchPromises.length} batch(es) in parallel...`);
    const batchResults = await Promise.all(batchPromises);

    batchResults.sort((a, b) => a.batchIndex - b.batchIndex);

    const results: ClassifiedSegment[] = [];
    for (const { batch, classifications } of batchResults) {
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
async function transformSegmentsBatch(
    segments: ClassifiedSegment[],
    contextBefore: ClassifiedSegment[],
    contextAfter: ClassifiedSegment[]
): Promise<string[]> {
    const client = await getGeminiClientAsync();

    const allSegments = [...contextBefore, ...segments, ...contextAfter];
    const segmentStartIndex = contextBefore.length;
    const segmentEndIndex = segmentStartIndex + segments.length;

    const segmentsText = segments
        .map((seg, idx) => {
            const globalIdx = segmentStartIndex + idx;
            return `[${globalIdx}] [${seg.classification}] "${seg.text}"`;
        })
        .join('\n');

    const contextText = allSegments.length > segments.length
        ? `\n\nContext (for reference only):\n${allSegments
            .map((seg, idx) => {
                const classification = 'classification' in seg ? `[${(seg as ClassifiedSegment).classification}]` : '';
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

Return a JSON array with transformed text for indices ${segmentStartIndex} to ${segmentEndIndex - 1} only, in order.

Example:
Input: ["um like this function could maybe be better", "I think we should add error handling here"]
Output: ["This function could be improved", "Consider adding error handling here"]

Transformed comments:`;

    const model = client.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    let transformedTexts: string[];
    try {
        transformedTexts = parseJsonArray<string>(text, segments.length);
    } catch (error) {
        console.error('Failed to parse Gemini transformation response:', text);
        throw new Error(`Failed to parse transformation response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    if (!Array.isArray(transformedTexts) || transformedTexts.length !== segments.length) {
        throw new Error(`Expected ${segments.length} transformed texts, got ${transformedTexts.length}`);
    }

    return transformedTexts;
}

/**
 * Transform classified segments in parallel batches
 */
export async function transformSegmentsInBatches(
    classifiedSegments: ClassifiedSegment[]
): Promise<TransformedSegment[]> {
    const segmentsToTransform = classifiedSegments.filter(seg => seg.classification !== 'Ignore');

    if (segmentsToTransform.length === 0) {
        return [];
    }

    const originalIndices = new Map<ClassifiedSegment, number>();
    classifiedSegments.forEach((seg, idx) => {
        originalIndices.set(seg, idx);
    });

    const batchPromises: Promise<{ batchIndex: number; batch: ClassifiedSegment[]; transformedTexts: string[] }>[] = [];

    for (let i = 0; i < segmentsToTransform.length; i += BATCH_SIZE_TRANSFORM) {
        const batchEnd = Math.min(i + BATCH_SIZE_TRANSFORM, segmentsToTransform.length);
        const batch = segmentsToTransform.slice(i, batchEnd);
        const batchIndex = i;

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

        const batchPromise = transformSegmentsBatch(batch, contextBefore, contextAfter)
            .then(transformedTexts => ({ batchIndex, batch, transformedTexts }));

        batchPromises.push(batchPromise);
    }

    console.log(`[Transform] Processing ${batchPromises.length} batch(es) in parallel...`);
    const batchResults = await Promise.all(batchPromises);

    batchResults.sort((a, b) => a.batchIndex - b.batchIndex);

    const results: TransformedSegment[] = [];
    for (const { batch, transformedTexts } of batchResults) {
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
 */
async function splitSegmentsBatch(
    segments: ClassifiedSegment[],
    contextBefore: ClassifiedSegment[],
    contextAfter: ClassifiedSegment[]
): Promise<(string | string[])[]> {
    const client = await getGeminiClientAsync();

    const allSegments = [...contextBefore, ...segments, ...contextAfter];
    const segmentStartIndex = contextBefore.length;
    const segmentEndIndex = segmentStartIndex + segments.length;

    const segmentsText = segments
        .map((seg, idx) => {
            const globalIdx = segmentStartIndex + idx;
            return `[${globalIdx}] [${seg.classification}] Speaker ${seg.speakerTag}: "${seg.text}" (${seg.startTime.toFixed(2)}s - ${seg.endTime.toFixed(2)}s)`;
        })
        .join('\n');

    const contextText = allSegments.length > segments.length
        ? `\n\nContext (for reference only):\n${allSegments
            .map((seg, idx) => {
                const classification = 'classification' in seg ? `[${(seg as ClassifiedSegment).classification}]` : '';
                return `[${idx}] ${classification} Speaker ${seg.speakerTag}: "${seg.text}"`;
            })
            .join('\n')}`
        : '';

    const prompt = `You are analyzing code review speech segments to determine if they should be split into multiple comments and to identify duplicate segments.

A segment should be split if:
- It discusses multiple distinct topics
- It would be clearer as multiple focused comments
- The segment is very long and covers multiple unrelated points

A segment should NOT be split if:
- It's a single coherent thought or topic
- The parts are closely related

IMPORTANT: Duplicate Detection
- If a segment expresses the same meaning as another segment, mark it as "duplicate"
- Keep the FIRST occurrence and mark subsequent duplicates

For each segment below (indices ${segmentStartIndex} to ${segmentEndIndex - 1}), return:
- "keep" if the segment should remain as-is
- An array of strings if the segment should be split
- "duplicate" if it's a duplicate of another segment

Segments to analyze:${segmentsText}${contextText}

Return ONLY a valid JSON array with exactly ${segments.length} element(s).

Example for 3 segments:
[["This function could be improved", "Also we should add error handling here"], "keep", "duplicate"]

Now return the JSON array:`;

    const model = client.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    let splitDecisions: (string | string[])[];
    try {
        splitDecisions = parseJsonArray<(string | string[])>(text, segments.length);
    } catch (error) {
        console.error('Failed to parse Gemini split response:', text);
        throw new Error(`Failed to parse split response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    if (splitDecisions.length !== segments.length) {
        throw new Error(`Expected ${segments.length} split decisions, got ${splitDecisions.length}`);
    }

    return splitDecisions;
}

/**
 * Split segments in parallel batches
 */
export async function splitSegmentsInBatches(
    classifiedSegments: ClassifiedSegment[]
): Promise<ClassifiedSegment[]> {
    if (classifiedSegments.length === 0) {
        return [];
    }

    const batchPromises: Promise<{ batchIndex: number; batch: ClassifiedSegment[]; splitDecisions: (string | string[])[] }>[] = [];

    for (let i = 0; i < classifiedSegments.length; i += BATCH_SIZE_SPLIT) {
        const batchEnd = Math.min(i + BATCH_SIZE_SPLIT, classifiedSegments.length);
        const batch = classifiedSegments.slice(i, batchEnd);
        const batchIndex = i;

        const contextBefore = classifiedSegments.slice(Math.max(0, i - CONTEXT_SIZE), i);
        const contextAfter = classifiedSegments.slice(batchEnd, Math.min(classifiedSegments.length, batchEnd + CONTEXT_SIZE));

        const batchPromise = splitSegmentsBatch(batch, contextBefore, contextAfter)
            .then(splitDecisions => ({ batchIndex, batch, splitDecisions }));

        batchPromises.push(batchPromise);
    }

    console.log(`[Split] Processing ${batchPromises.length} batch(es) in parallel...`);
    const batchResults = await Promise.all(batchPromises);

    batchResults.sort((a, b) => a.batchIndex - b.batchIndex);

    const results: ClassifiedSegment[] = [];
    let totalDuplicatesFiltered = 0;

    for (const { batch, splitDecisions } of batchResults) {
        for (let j = 0; j < batch.length; j++) {
            const segment = batch[j];
            const decision = splitDecisions[j];

            if (decision === 'duplicate') {
                totalDuplicatesFiltered++;
                console.log(`[Deduplication] Filtered duplicate: "${segment.text.substring(0, 50)}..."`);
            } else if (decision === 'keep') {
                results.push(segment);
            } else if (Array.isArray(decision)) {
                const splitParts = decision as string[];
                const segmentDuration = segment.endTime - segment.startTime;
                let currentTime = segment.startTime;

                for (const part of splitParts) {
                    const trimmedPart = part.trim();
                    if (!trimmedPart) continue;

                    const partDuration = (trimmedPart.length / segment.text.length) * segmentDuration;
                    results.push({
                        speakerTag: segment.speakerTag,
                        text: trimmedPart,
                        startTime: currentTime,
                        endTime: currentTime + partDuration,
                        classification: segment.classification,
                    });
                    currentTime += partDuration;
                }
            }
        }
    }

    if (totalDuplicatesFiltered > 0) {
        console.log(`[Deduplication] Total: Filtered ${totalDuplicatesFiltered} duplicate segment(s)`);
    }

    return results;
}

/**
 * Combined processing: classify, split, and transform segments in a single API call
 * This is the main function for processing speech segments
 */
export async function processSegmentsCombined(
    segments: SpeakerSegment[]
): Promise<TransformedSegment[]> {
    if (segments.length === 0) {
        return [];
    }

    const client = await getGeminiClientAsync();

    console.log(`[ProcessCombined] Processing ${segments.length} segment(s) in single API call...`);

    const segmentsText = segments
        .map((seg, idx) => `[${idx}] Speaker ${seg.speakerTag}: "${seg.text}" (${seg.startTime.toFixed(2)}s - ${seg.endTime.toFixed(2)}s)`)
        .join('\n');

    const prompt = `You are processing spoken code review segments. For each segment, you must:

1. **Classify** into exactly one category:
   - Ignore: Off-topic, filler words, or not relevant to code review
   - Question: Asking about how something works or why it was done
   - Concern: Expressing worry about potential issues or problems
   - Suggestion: Proposing improvements or alternatives
   - Style: Comments about code style, readability, or formatting

2. **Split** if the segment covers multiple distinct topics that would be clearer as separate comments. Otherwise keep as one.

3. **Transform** each part into a polished, professional code review comment:
   - Remove filler words ("um", "uh", "like", "you know")
   - Fix grammar and make language professional
   - Keep it concise and appropriate for code reviews
   - If classification is "Ignore", return empty transformedParts array

4. **Detect duplicates**: If a segment expresses the same meaning as a previous segment, mark it with classification "Ignore" and empty transformedParts.

Segments to process:
${segmentsText}

Return ONLY a valid JSON array with exactly ${segments.length} element(s), one for each segment in order.
Each element must be an object with:
- "classification": one of "Ignore", "Question", "Concern", "Suggestion", "Style"
- "transformedParts": array of polished comment strings (empty array if Ignore or duplicate)

Example for 3 segments:
[
  {"classification": "Question", "transformedParts": ["What does this function do?"]},
  {"classification": "Suggestion", "transformedParts": ["Add error handling to this section", "Consider refactoring the validation logic"]},
  {"classification": "Ignore", "transformedParts": []}
]

IMPORTANT: Return ONLY the JSON array, no markdown, no explanations.

Process the segments above:`;

    const model = client.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    interface CombinedResult {
        classification: string;
        transformedParts: string[];
    }

    let results: CombinedResult[];
    try {
        results = parseJsonArray<CombinedResult>(text, segments.length);
    } catch (error) {
        console.error('[ProcessCombined] Failed to parse Gemini response:', text);
        throw new Error(`Failed to parse combined processing response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    if (!Array.isArray(results)) {
        throw new Error(`Expected array, got ${typeof results}`);
    }

    if (results.length !== segments.length) {
        throw new Error(`Expected ${segments.length} results, got ${results.length}`);
    }

    const transformedSegments: TransformedSegment[] = [];

    for (let i = 0; i < results.length; i++) {
        const resultItem = results[i];
        const segment = segments[i];

        if (!VALID_CLASSIFICATIONS.includes(resultItem.classification as SegmentClassification)) {
            console.warn(`[ProcessCombined] Invalid classification "${resultItem.classification}" at index ${i}, defaulting to Ignore`);
            resultItem.classification = 'Ignore';
        }

        if (resultItem.classification === 'Ignore') {
            continue;
        }

        if (!Array.isArray(resultItem.transformedParts) || resultItem.transformedParts.length === 0) {
            console.warn(`[ProcessCombined] Empty transformedParts for non-Ignore segment at index ${i}, skipping`);
            continue;
        }

        const segmentDuration = segment.endTime - segment.startTime;
        const partDuration = segmentDuration / resultItem.transformedParts.length;

        for (let j = 0; j < resultItem.transformedParts.length; j++) {
            const partText = resultItem.transformedParts[j]?.trim();
            if (!partText) continue;

            transformedSegments.push({
                speakerTag: segment.speakerTag,
                text: segment.text,
                startTime: segment.startTime + (j * partDuration),
                endTime: segment.startTime + ((j + 1) * partDuration),
                classification: resultItem.classification as SegmentClassification,
                transformedText: partText,
            });
        }
    }

    console.log(`[ProcessCombined] ✓ Processed ${segments.length} segments -> ${transformedSegments.length} transformed segments`);
    return transformedSegments;
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
    allCandidates: Array<CandidateLocation[]>
): Promise<LocationSelection[]> {
    console.log(`[Location Selection Batch] Processing ${segments.length} comment location selections`);

    if (segments.length === 0) {
        return [];
    }

    if (segments.length !== allCandidates.length) {
        throw new Error(`Mismatch: ${segments.length} segments but ${allCandidates.length} candidate arrays`);
    }

    const client = await getGeminiClientAsync();

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

Return ONLY the JSON array, no other text, no markdown, no explanations.

Selections:`;

    console.log(`[Location Selection Batch] Calling Gemini API...`);
    const model = client.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    let selections: LocationSelection[];
    try {
        selections = parseJsonArray<LocationSelection>(text, segments.length);
    } catch (error) {
        console.error('[Location Selection Batch] Failed to parse Gemini response:', text);
        throw new Error(`Failed to parse batch location selection response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

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
            throw new Error(`Invalid selectedIndex at index ${i}: expected number`);
        }

        if (selection.selectedIndex < 0 || selection.selectedIndex >= candidates.length) {
            throw new Error(`Selected index ${selection.selectedIndex} at segment ${i} is out of range (0-${candidates.length - 1})`);
        }
    }

    console.log(`[Location Selection Batch] ✓ Successfully processed ${selections.length} location selections`);
    return selections;
}

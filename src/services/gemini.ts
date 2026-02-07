/**
 * Gemini service for processing speech segments
 * Handles classification, splitting, and transformation of spoken code review comments
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  SpeakerSegment,
  TransformedSegment,
  SegmentClassification,
  CandidateLocation,
  LocationSelection,
} from "../types";
import { VALID_CLASSIFICATIONS } from "../types";
import { parseJsonArray } from "../utils/jsonParser";

// Configuration constants
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";

// Gemini client (lazily initialized)
let geminiClient: GoogleGenerativeAI | null = null;
let cachedApiKey: string | null = null;

// Function to get API key from secret storage (set by extension)
let getApiKeyFromSecrets: (() => Promise<string | undefined>) | null = null;

/**
 * Initialize the Gemini service with a function to retrieve the API key from secrets
 * This must be called during extension activation
 */
export function initializeGeminiService(
  getApiKey: () => Promise<string | undefined>,
): void {
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
    throw new Error(
      'Gemini API key not configured. Use the "PR Notes: Set Gemini API Key" command to set your API key.',
    );
  }

  geminiClient = new GoogleGenerativeAI(apiKey);
  cachedApiKey = apiKey;
  return geminiClient;
}

/**
 * Embed multiple text strings using Gemini embedding model (batch).
 * Used by semantic chunking to compute similarity between transcript units.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  const client = await getGeminiClientAsync();
  const embedModel = client.getGenerativeModel({
    model: GEMINI_EMBEDDING_MODEL,
  });
  const requests = texts.map((text) => ({
    content: { role: "user", parts: [{ text }] },
  }));
  const result = await embedModel.batchEmbedContents({ requests });
  return result.embeddings.map((e) => e.values);
}

/**
 * Combined processing: classify, split, and transform segments in a single API call
 * This is the main function for processing speech segments
 */
export async function processSegmentsCombined(
  segments: SpeakerSegment[],
): Promise<TransformedSegment[]> {
  if (segments.length === 0) {
    return [];
  }

  const client = await getGeminiClientAsync();

  console.log(
    `[ProcessCombined] Processing ${segments.length} segment(s) in single API call...`,
  );

  const segmentsText = segments
    .map(
      (seg, idx) =>
        `[${idx}] Speaker ${seg.speakerTag}: "${seg.text}" (${seg.startTime.toFixed(2)}s - ${seg.endTime.toFixed(2)}s)`,
    )
    .join("\n");

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
    console.error("[ProcessCombined] Failed to parse Gemini response:", text);
    throw new Error(
      `Failed to parse combined processing response: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  if (!Array.isArray(results)) {
    throw new Error(`Expected array, got ${typeof results}`);
  }

  if (results.length !== segments.length) {
    throw new Error(
      `Expected ${segments.length} results, got ${results.length}`,
    );
  }

  const transformedSegments: TransformedSegment[] = [];

  for (let i = 0; i < results.length; i++) {
    const resultItem = results[i];
    const segment = segments[i];

    if (
      !VALID_CLASSIFICATIONS.includes(
        resultItem.classification as SegmentClassification,
      )
    ) {
      console.warn(
        `[ProcessCombined] Invalid classification "${resultItem.classification}" at index ${i}, defaulting to Ignore`,
      );
      resultItem.classification = "Ignore";
    }

    if (resultItem.classification === "Ignore") {
      continue;
    }

    if (
      !Array.isArray(resultItem.transformedParts) ||
      resultItem.transformedParts.length === 0
    ) {
      console.warn(
        `[ProcessCombined] Empty transformedParts for non-Ignore segment at index ${i}, skipping`,
      );
      continue;
    }

    const segmentDuration = segment.endTime - segment.startTime;
    const partDuration = segmentDuration / resultItem.transformedParts.length;

    for (let j = 0; j < resultItem.transformedParts.length; j++) {
      const partText = resultItem.transformedParts[j]?.trim();
      if (!partText) {
        continue;
      }

      transformedSegments.push({
        speakerTag: segment.speakerTag,
        text: segment.text,
        startTime: segment.startTime + j * partDuration,
        endTime: segment.startTime + (j + 1) * partDuration,
        classification: resultItem.classification as SegmentClassification,
        transformedText: partText,
      });
    }
  }

  console.log(
    `[ProcessCombined] ✓ Processed ${segments.length} segments -> ${transformedSegments.length} transformed segments`,
  );
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
  allCandidates: Array<CandidateLocation[]>,
): Promise<LocationSelection[]> {
  console.log(
    `[Location Selection Batch] Processing ${segments.length} comment location selections`,
  );

  if (segments.length === 0) {
    return [];
  }

  if (segments.length !== allCandidates.length) {
    throw new Error(
      `Mismatch: ${segments.length} segments but ${allCandidates.length} candidate arrays`,
    );
  }

  const client = await getGeminiClientAsync();

  const segmentDescriptions = segments
    .map((segment, idx) => {
      const candidates = allCandidates[idx];
      const candidateDescriptions = candidates
        .map((candidate, candIdx) => {
          const codeContext =
            candidate.codeContext || "(No code context available)";
          return `  Candidate [${candIdx}]:
    - File: ${candidate.file}
    - Timestamp: ${candidate.timestamp.toFixed(2)}s
    - Cursor Line: ${candidate.cursorLine}
    - Visible Range: Lines ${candidate.visibleRange[0]}-${candidate.visibleRange[1]}
    - Symbols in View: ${candidate.symbolsInView.join(", ") || "(none)"}
    - Code Context:
${codeContext
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}`;
        })
        .join("\n\n");

      return `Segment [${idx}]:
- Text: "${segment.commentText}"
- Classification: ${segment.classification}
- File: ${segment.fileName}
- Timestamp: ${segment.timestamp.toFixed(2)}s
- Candidates:
${candidateDescriptions}`;
    })
    .join("\n\n---\n\n");

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
    console.error(
      "[Location Selection Batch] Failed to parse Gemini response:",
      text,
    );
    throw new Error(
      `Failed to parse batch location selection response: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  if (!Array.isArray(selections)) {
    throw new Error(`Expected array, got ${typeof selections}`);
  }

  if (selections.length !== segments.length) {
    throw new Error(
      `Expected ${segments.length} selections, got ${selections.length}`,
    );
  }

  // Validate each selection
  for (let i = 0; i < selections.length; i++) {
    const selection = selections[i];
    const candidates = allCandidates[i];

    if (typeof selection.selectedIndex !== "number") {
      throw new Error(`Invalid selectedIndex at index ${i}: expected number`);
    }

    if (
      selection.selectedIndex < 0 ||
      selection.selectedIndex >= candidates.length
    ) {
      throw new Error(
        `Selected index ${selection.selectedIndex} at segment ${i} is out of range (0-${candidates.length - 1})`,
      );
    }
  }

  console.log(
    `[Location Selection Batch] ✓ Successfully processed ${selections.length} location selections`,
  );
  return selections;
}

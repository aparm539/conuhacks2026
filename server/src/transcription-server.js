"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const speech_1 = require("@google-cloud/speech");
const generative_ai_1 = require("@google/generative-ai");
// Load environment variables
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '10mb' }));
let speechClient = null;
let geminiClient = null;
function initializeSpeechClient() {
    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!clientEmail || !privateKey) {
        console.error('Google Cloud credentials not found in .env file');
        console.error('Please set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY');
        return;
    }
    speechClient = new speech_1.SpeechClient({
        credentials: {
            client_email: clientEmail,
            private_key: privateKey,
        },
    });
    console.log('Google Cloud Speech client initialized. big things are in the console.');
}
initializeSpeechClient();
function initializeGeminiClient() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('Gemini API key not found in .env file');
        console.error('Please set GEMINI_API_KEY');
        return;
    }
    geminiClient = new generative_ai_1.GoogleGenerativeAI(apiKey);
    console.log('Gemini client initialized');
}
initializeGeminiClient();
/**
 * Classify a batch of segments with surrounding context
 */
async function classifySegmentsBatch(segments, contextBefore, contextAfter) {
    if (!geminiClient) {
        throw new Error('Gemini client not initialized');
    }
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
    const model = geminiClient.getGenerativeModel({ model: 'gemini-3-flash-preview' });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    // Parse JSON response
    let classifications;
    try {
        // Extract JSON from response (might have markdown code blocks)
        const jsonMatch = text.match(/\[.*?\]/s);
        if (jsonMatch) {
            classifications = JSON.parse(jsonMatch[0]);
        }
        else {
            classifications = JSON.parse(text);
        }
    }
    catch (error) {
        console.error('Failed to parse Gemini response:', text);
        throw new Error(`Failed to parse classification response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    // Validate classifications
    const validClassifications = ['Ignore', 'Question', 'Concern', 'Suggestion', 'Style'];
    if (!Array.isArray(classifications) || classifications.length !== segments.length) {
        throw new Error(`Expected ${segments.length} classifications, got ${classifications.length}`);
    }
    // Validate each classification
    for (let i = 0; i < classifications.length; i++) {
        if (!validClassifications.includes(classifications[i])) {
            throw new Error(`Invalid classification at index ${i}: ${classifications[i]}`);
        }
    }
    return classifications;
}
/**
 * Classify segments sequentially in batches with context
 */
async function classifySegmentsSequentially(segments) {
    if (segments.length === 0) {
        return [];
    }
    const BATCH_SIZE = 7; // Process 5-10 segments per batch, using 7 as middle ground
    const CONTEXT_SIZE = 2; // Include 1-2 segments before/after for context
    const results = [];
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
        const batchEnd = Math.min(i + BATCH_SIZE, segments.length);
        const batch = segments.slice(i, batchEnd);
        // Get context segments
        const contextBefore = segments.slice(Math.max(0, i - CONTEXT_SIZE), i);
        const contextAfter = segments.slice(batchEnd, Math.min(segments.length, batchEnd + CONTEXT_SIZE));
        // Classify batch
        const classifications = await classifySegmentsBatch(batch, contextBefore, contextAfter);
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
async function transformSegmentsBatch(segments, contextBefore, contextAfter) {
    if (!geminiClient) {
        throw new Error('Gemini client not initialized');
    }
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
    const model = geminiClient.getGenerativeModel({ model: 'gemini-3-flash-preview' });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    // Parse JSON response
    let transformedTexts;
    try {
        // Extract JSON from response (might have markdown code blocks)
        const jsonMatch = text.match(/\[.*?\]/s);
        if (jsonMatch) {
            transformedTexts = JSON.parse(jsonMatch[0]);
        }
        else {
            transformedTexts = JSON.parse(text);
        }
    }
    catch (error) {
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
async function transformSegmentsSequentially(classifiedSegments) {
    // Filter out Ignore segments - they won't be transformed
    const segmentsToTransform = classifiedSegments.filter(seg => seg.classification !== 'Ignore');
    if (segmentsToTransform.length === 0) {
        // Return empty array if all segments are Ignore
        return [];
    }
    const BATCH_SIZE = 7; // Process 5-10 segments per batch, using 7 as middle ground
    const CONTEXT_SIZE = 2; // Include 1-2 segments before/after for context
    const results = [];
    // Create a map to track original indices for context lookup
    const originalIndices = new Map();
    classifiedSegments.forEach((seg, idx) => {
        originalIndices.set(seg, idx);
    });
    for (let i = 0; i < segmentsToTransform.length; i += BATCH_SIZE) {
        const batchEnd = Math.min(i + BATCH_SIZE, segmentsToTransform.length);
        const batch = segmentsToTransform.slice(i, batchEnd);
        // Get context segments from the original array (including Ignore segments for context)
        const batchStartOriginalIdx = originalIndices.get(batch[0]);
        const batchEndOriginalIdx = originalIndices.get(batch[batch.length - 1]);
        const contextBefore = classifiedSegments.slice(Math.max(0, batchStartOriginalIdx - CONTEXT_SIZE), batchStartOriginalIdx);
        const contextAfter = classifiedSegments.slice(batchEndOriginalIdx + 1, Math.min(classifiedSegments.length, batchEndOriginalIdx + 1 + CONTEXT_SIZE));
        // Transform batch
        const transformedTexts = await transformSegmentsBatch(batch, contextBefore, contextAfter);
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
async function splitSegmentsBatch(segments, contextBefore, contextAfter) {
    if (!geminiClient) {
        throw new Error('Gemini client not initialized');
    }
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
    const prompt = `You are analyzing code review speech segments to determine if they should be split into multiple comments.

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

For each segment below (indices ${segmentStartIndex} to ${segmentEndIndex - 1}), analyze whether it should be split. If it should be split, identify natural break points in the text and return an array of the split text parts. If it should not be split, return "keep".

Segments to analyze:${segmentsText}${contextText}

Return ONLY a valid JSON array with exactly ${segments.length} element(s), one for each segment in order. Each element must be either:
- The string "keep" (if the segment should remain as one comment)
- An array of strings (if the segment should be split, each string is a part of the original text)

IMPORTANT: Return ONLY the JSON array, no other text, no markdown, no explanations.

Example for 2 segments:
Input:
[0] [Suggestion] Speaker 1: "This function could be improved and also we should add error handling here"
[1] [Question] Speaker 1: "How does this work?"

Output (JSON only):
[["This function could be improved", "Also we should add error handling here"], "keep"]

Now return the JSON array for the segments above:`;
    const model = geminiClient.getGenerativeModel({ model: 'gemini-3-flash-preview' });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    // Parse JSON response
    let splitDecisions;
    try {
        // Try to extract JSON from response (might have markdown code blocks or extra whitespace)
        let jsonText = text.trim();
        // Remove markdown code blocks if present
        jsonText = jsonText.replace(/^```(?:json)?\s*/gm, '').replace(/```\s*$/gm, '').trim();
        // Remove any leading/trailing non-JSON text (common with LLM responses)
        // Find the first '[' and last ']'
        const firstBracket = jsonText.indexOf('[');
        const lastBracket = jsonText.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
            jsonText = jsonText.substring(firstBracket, lastBracket + 1);
        }
        // Try to find the outermost array by matching balanced brackets
        let parsed;
        try {
            parsed = JSON.parse(jsonText);
        }
        catch (parseError) {
            // If direct parse fails, try to extract array with balanced bracket matching
            let bracketCount = 0;
            let startIdx = -1;
            let inString = false;
            let escapeNext = false;
            for (let i = 0; i < jsonText.length; i++) {
                const char = jsonText[i];
                if (escapeNext) {
                    escapeNext = false;
                    continue;
                }
                if (char === '\\') {
                    escapeNext = true;
                    continue;
                }
                if (char === '"' && !escapeNext) {
                    inString = !inString;
                    continue;
                }
                if (!inString) {
                    if (char === '[') {
                        if (startIdx === -1)
                            startIdx = i;
                        bracketCount++;
                    }
                    else if (char === ']') {
                        bracketCount--;
                        if (bracketCount === 0 && startIdx !== -1) {
                            const arrayText = jsonText.substring(startIdx, i + 1);
                            try {
                                parsed = JSON.parse(arrayText);
                                break;
                            }
                            catch (e) {
                                // Continue searching
                                startIdx = -1;
                                bracketCount = 0;
                            }
                        }
                    }
                }
            }
            if (!parsed) {
                console.error('Could not extract valid JSON array from response. Attempted to parse:', jsonText.substring(0, 500));
                throw parseError;
            }
        }
        // Log what we parsed for debugging
        if (segments.length === 1) {
            console.log(`[Split] Parsed response for 1 segment:`, JSON.stringify(parsed));
        }
        // Handle nested arrays (Gemini sometimes wraps responses incorrectly)
        if (Array.isArray(parsed)) {
            // If we got a nested array where the inner array has the right length, use it
            if (parsed.length === 1 && Array.isArray(parsed[0])) {
                const inner = parsed[0];
                // Check if inner array has the correct number of elements
                if (inner.length === segments.length) {
                    // Verify it has the right structure (each element is "keep" or array of strings)
                    const isValid = inner.every(item => item === 'keep' || (Array.isArray(item) && item.every(part => typeof part === 'string')));
                    if (isValid) {
                        splitDecisions = inner;
                    }
                    else {
                        splitDecisions = parsed;
                    }
                }
                else {
                    splitDecisions = parsed;
                }
            }
            else {
                splitDecisions = parsed;
            }
        }
        else {
            throw new Error('Response is not an array');
        }
    }
    catch (error) {
        console.error('Failed to parse Gemini split response. Raw text:', text);
        console.error('Parse error:', error);
        throw new Error(`Failed to parse split response: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
        if (decision === 'keep') {
            continue;
        }
        if (!Array.isArray(decision) || decision.length === 0) {
            throw new Error(`Invalid split decision at index ${i}: expected "keep" or array of strings, got ${typeof decision}`);
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
async function splitSegmentsSequentially(classifiedSegments) {
    if (classifiedSegments.length === 0) {
        return [];
    }
    const BATCH_SIZE = 5; // Process fewer segments at a time for splitting analysis
    const CONTEXT_SIZE = 2; // Include 1-2 segments before/after for context
    const results = [];
    for (let i = 0; i < classifiedSegments.length; i += BATCH_SIZE) {
        const batchEnd = Math.min(i + BATCH_SIZE, classifiedSegments.length);
        const batch = classifiedSegments.slice(i, batchEnd);
        // Get context segments
        const contextBefore = classifiedSegments.slice(Math.max(0, i - CONTEXT_SIZE), i);
        const contextAfter = classifiedSegments.slice(batchEnd, Math.min(classifiedSegments.length, batchEnd + CONTEXT_SIZE));
        // Get split decisions
        const splitDecisions = await splitSegmentsBatch(batch, contextBefore, contextAfter);
        // Process each segment based on split decision
        for (let j = 0; j < batch.length; j++) {
            const segment = batch[j];
            const decision = splitDecisions[j];
            if (decision === 'keep') {
                // Keep segment as-is
                results.push(segment);
            }
            else if (Array.isArray(decision)) {
                // Split segment into multiple segments
                const splitParts = decision;
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
    }
    return results;
}
/**
 * Select the best location for a comment using Gemini
 */
async function selectCommentLocation(commentText, classification, candidates, fileName) {
    console.log(`[Location Selection] Starting location selection for comment: "${commentText.substring(0, 50)}${commentText.length > 50 ? '...' : ''}"`);
    console.log(`[Location Selection] Classification: ${classification}, File: ${fileName}, Candidates: ${candidates.length}`);
    if (!geminiClient) {
        console.error('[Location Selection] ERROR: Gemini client not initialized');
        throw new Error('Gemini client not initialized');
    }
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
    const model = geminiClient.getGenerativeModel({ model: 'gemini-3-flash-preview' });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    console.log(`[Location Selection] Received response from Gemini (${text.length} chars)`);
    // Parse JSON response
    let selection;
    try {
        // Extract JSON from response (might have markdown code blocks)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            selection = JSON.parse(jsonMatch[0]);
            console.log(`[Location Selection] Parsed JSON from response (extracted from markdown)`);
        }
        else {
            selection = JSON.parse(text);
            console.log(`[Location Selection] Parsed JSON directly from response`);
        }
    }
    catch (error) {
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
app.post('/transcribe', async (req, res) => {
    try {
        if (!speechClient) {
            return res.status(500).json({
                error: 'Speech client not initialized. Check server logs for credential errors.'
            });
        }
        const { audio } = req.body;
        if (!audio || typeof audio !== 'string') {
            return res.status(400).json({
                error: 'Missing or invalid audio data. Expected base64 encoded audio string.'
            });
        }
        // Convert base64 string to Buffer
        const audioBuffer = Buffer.from(audio, 'base64');
        const diarizationConfig = {
            enableSpeakerDiarization: true,
            minSpeakerCount: 1,
            maxSpeakerCount: 10,
        };
        const config = {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            languageCode: 'en-US',
            diarizationConfig: diarizationConfig,
            enableWordTimeOffsets: true,
        };
        const audioConfig = {
            content: audioBuffer,
        };
        const request = {
            config: config,
            audio: audioConfig,
        };
        const [response] = await speechClient.recognize(request);
        if (!response.results || response.results.length === 0) {
            return res.status(404).json({
                error: 'No transcription results returned from Google Cloud Speech API'
            });
        }
        // Extract words from the last result (speaker tags only appear in the final result)
        const lastResult = response.results[response.results.length - 1];
        const alternative = lastResult.alternatives?.[0];
        if (!alternative || !alternative.words) {
            return res.status(404).json({
                error: 'No words found in transcription results'
            });
        }
        // Helper function to format Duration to string (e.g., "1.100s")
        const formatDuration = (duration) => {
            if (!duration)
                return '0s';
            const seconds = duration.seconds || 0;
            const nanos = duration.nanos || 0;
            const totalSeconds = Number(seconds) + (nanos / 1000000000);
            // Format with up to 3 decimal places if needed
            if (totalSeconds === Math.floor(totalSeconds)) {
                return `${totalSeconds}s`;
            }
            return `${totalSeconds.toFixed(3)}s`;
        };
        // Map words to include speaker tags and timestamps
        const words = alternative.words.map((wordInfo) => ({
            word: wordInfo.word || '',
            speakerTag: wordInfo.speakerTag || 0,
            startOffset: formatDuration(wordInfo.startTime),
            endOffset: formatDuration(wordInfo.endTime),
        }));
        res.json({ words });
    }
    catch (error) {
        console.error('Transcription error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        res.status(500).json({ error: `Transcription failed: ${errorMessage}` });
    }
});
app.post('/classify', async (req, res) => {
    try {
        if (!geminiClient) {
            return res.status(500).json({
                classifiedSegments: [],
                error: 'Gemini client not initialized. Check server logs for API key errors.'
            });
        }
        const { segments } = req.body;
        if (!segments || !Array.isArray(segments)) {
            return res.status(400).json({
                classifiedSegments: [],
                error: 'Missing or invalid segments data. Expected array of segments.'
            });
        }
        if (segments.length === 0) {
            return res.json({ classifiedSegments: [] });
        }
        // Validate segment structure
        for (const segment of segments) {
            if (typeof segment.speakerTag !== 'number' ||
                typeof segment.text !== 'string' ||
                typeof segment.startTime !== 'number' ||
                typeof segment.endTime !== 'number') {
                return res.status(400).json({
                    classifiedSegments: [],
                    error: 'Invalid segment structure. Expected { speakerTag: number, text: string, startTime: number, endTime: number }'
                });
            }
        }
        const classifiedSegments = await classifySegmentsSequentially(segments);
        res.json({ classifiedSegments });
    }
    catch (error) {
        console.error('Classification error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        res.status(500).json({
            classifiedSegments: [],
            error: `Classification failed: ${errorMessage}`
        });
    }
});
app.post('/transform', async (req, res) => {
    try {
        if (!geminiClient) {
            return res.status(500).json({
                transformedSegments: [],
                error: 'Gemini client not initialized. Check server logs for API key errors.'
            });
        }
        const { classifiedSegments } = req.body;
        if (!classifiedSegments || !Array.isArray(classifiedSegments)) {
            return res.status(400).json({
                transformedSegments: [],
                error: 'Missing or invalid classifiedSegments data. Expected array of ClassifiedSegment.'
            });
        }
        if (classifiedSegments.length === 0) {
            return res.json({ transformedSegments: [] });
        }
        // Validate segment structure
        for (const segment of classifiedSegments) {
            if (typeof segment.speakerTag !== 'number' ||
                typeof segment.text !== 'string' ||
                typeof segment.startTime !== 'number' ||
                typeof segment.endTime !== 'number' ||
                !segment.classification ||
                !['Ignore', 'Question', 'Concern', 'Suggestion', 'Style'].includes(segment.classification)) {
                return res.status(400).json({
                    transformedSegments: [],
                    error: 'Invalid segment structure. Expected ClassifiedSegment with classification field.'
                });
            }
        }
        const transformedSegments = await transformSegmentsSequentially(classifiedSegments);
        res.json({ transformedSegments });
    }
    catch (error) {
        console.error('Transformation error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        res.status(500).json({
            transformedSegments: [],
            error: `Transformation failed: ${errorMessage}`
        });
    }
});
app.post('/split', async (req, res) => {
    try {
        if (!geminiClient) {
            return res.status(500).json({
                splitSegments: [],
                error: 'Gemini client not initialized. Check server logs for API key errors.'
            });
        }
        const { classifiedSegments } = req.body;
        if (!classifiedSegments || !Array.isArray(classifiedSegments)) {
            return res.status(400).json({
                splitSegments: [],
                error: 'Missing or invalid classifiedSegments data. Expected array of ClassifiedSegment.'
            });
        }
        if (classifiedSegments.length === 0) {
            return res.json({ splitSegments: [] });
        }
        // Validate segment structure
        for (const segment of classifiedSegments) {
            if (typeof segment.speakerTag !== 'number' ||
                typeof segment.text !== 'string' ||
                typeof segment.startTime !== 'number' ||
                typeof segment.endTime !== 'number' ||
                !segment.classification ||
                !['Ignore', 'Question', 'Concern', 'Suggestion', 'Style'].includes(segment.classification)) {
                return res.status(400).json({
                    splitSegments: [],
                    error: 'Invalid segment structure. Expected ClassifiedSegment with classification field.'
                });
            }
        }
        const splitSegments = await splitSegmentsSequentially(classifiedSegments);
        res.json({ splitSegments });
    }
    catch (error) {
        console.error('Splitting error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        res.status(500).json({
            splitSegments: [],
            error: `Splitting failed: ${errorMessage}`
        });
    }
});
app.post('/select-comment-location', async (req, res) => {
    console.log(`[API] POST /select-comment-location - Request received`);
    try {
        if (!geminiClient) {
            console.error('[API] ERROR: Gemini client not initialized');
            return res.status(500).json({
                selectedIndex: 0,
                error: 'Gemini client not initialized. Check server logs for API key errors.'
            });
        }
        const { commentText, classification, candidates, fileName } = req.body;
        console.log(`[API] Request body: commentText="${commentText?.substring(0, 50)}${commentText?.length > 50 ? '...' : ''}", classification=${classification}, fileName=${fileName}, candidates=${candidates?.length || 0}`);
        if (!commentText || typeof commentText !== 'string') {
            console.error('[API] ERROR: Missing or invalid commentText');
            return res.status(400).json({
                selectedIndex: 0,
                error: 'Missing or invalid commentText. Expected string.'
            });
        }
        if (!classification || !['Ignore', 'Question', 'Concern', 'Suggestion', 'Style'].includes(classification)) {
            console.error(`[API] ERROR: Missing or invalid classification: ${classification}`);
            return res.status(400).json({
                selectedIndex: 0,
                error: 'Missing or invalid classification. Expected one of: Ignore, Question, Concern, Suggestion, Style.'
            });
        }
        if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
            console.error(`[API] ERROR: Missing or invalid candidates: ${candidates ? 'empty array' : 'missing'}`);
            return res.status(400).json({
                selectedIndex: 0,
                error: 'Missing or invalid candidates. Expected non-empty array of CandidateLocation.'
            });
        }
        // Validate candidate structure
        console.log(`[API] Validating ${candidates.length} candidate(s)...`);
        for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i];
            if (typeof candidate.timestamp !== 'number' ||
                typeof candidate.file !== 'string' ||
                typeof candidate.cursorLine !== 'number' ||
                !Array.isArray(candidate.visibleRange) ||
                candidate.visibleRange.length !== 2 ||
                !Array.isArray(candidate.symbolsInView) ||
                typeof candidate.codeContext !== 'string') {
                console.error(`[API] ERROR: Invalid candidate structure at index ${i}:`, {
                    timestamp: typeof candidate.timestamp,
                    file: typeof candidate.file,
                    cursorLine: typeof candidate.cursorLine,
                    visibleRange: Array.isArray(candidate.visibleRange) ? candidate.visibleRange.length : 'not array',
                    symbolsInView: Array.isArray(candidate.symbolsInView) ? 'array' : 'not array',
                    codeContext: typeof candidate.codeContext
                });
                return res.status(400).json({
                    selectedIndex: 0,
                    error: 'Invalid candidate structure. Expected CandidateLocation with all required fields.'
                });
            }
        }
        console.log(`[API] ✓ All candidates validated successfully`);
        console.log(`[API] Calling selectCommentLocation function...`);
        const selection = await selectCommentLocation(commentText, classification, candidates, fileName || '');
        console.log(`[API] ✓ Location selection completed: index=${selection.selectedIndex}`);
        res.json(selection);
    }
    catch (error) {
        console.error('[API] ERROR: Location selection failed:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        res.status(500).json({
            selectedIndex: 0,
            error: `Location selection failed: ${errorMessage}`
        });
    }
});
app.listen(PORT, () => {
    console.log(`Transcription server running on port ${PORT}`);
    if (!speechClient) {
        console.warn('WARNING: Speech client not initialized. Transcription requests will fail.');
    }
    if (!geminiClient) {
        console.warn('WARNING: Gemini client not initialized. Classification requests will fail.');
    }
});
//# sourceMappingURL=transcription-server.js.map
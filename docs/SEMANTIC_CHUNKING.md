# Semantic transcript chunking

This document describes the design and behavior of semantic transcript chunking: how the extension splits the review conversation into meaning-based chunks so that each chunk corresponds to one reviewable issue or suggestion and is used to generate one PR comment.

---

## Overview

Transcript segments arrive from the Fluid helper in 15-second audio batches. Rather than treating each segment (or each speaker turn) as one comment, we chunk by **meaning**: we split the transcript into short units (sentences), compute semantic similarity between neighboring units using Gemini embeddings, and merge adjacent units that discuss the same topic or intent. Each resulting chunk is then passed through the existing pipeline (Gemini classify/transform, location selection, comment creation). This produces one PR comment per logical issue or suggestion instead of one per time window or utterance.

Semantic chunking sits between the segment queue flush and `processSegmentsCombined` in [src/extension.ts](src/extension.ts). The transcript panel and queue still receive and display the original segments; only the batch sent to Gemini is chunked.

**Cross-batch state**: A chunk can span batches. The last merged chunk from each flush is kept as a **pending tail** (units + embeddings). On the next batch, the tail is prepended to the new units before merging; if the first unit of the new batch meets the similarity threshold with the tail’s last unit, they are merged into one chunk. On recording stop, the tail is flushed as one chunk (no further merging).

---

## Steps

1. **Split transcript into short units (sentences)**  
   Segment text is split on sentence boundaries (`.`, `?`, `!`, newlines). Each unit is a [TranscriptUnit](src/types.ts) with `text`, `startTime`, `endTime`, and `speakerTag`. Time is distributed proportionally by character length within each segment.

2. **Embed units**  
   Unit texts are embedded in one batch via [src/services/gemini.ts](src/services/gemini.ts) **`embedTexts(texts)`**, which uses the Gemini model **`gemini-embedding-001`** and `batchEmbedContents`. Returns one embedding vector per unit.

3. **Compute cosine similarity between neighboring units**  
   For each adjacent pair `(i, i+1)`, similarity is `dot(a,b) / (||a|| * ||b||)`.

4. **Merge adjacent units above a threshold**  
   Units are processed in order. If `similarity(unit[i], unit[i+1]) >= threshold` (default 0.75), the next unit is merged into the current chunk (text appended, `endTime` extended). Otherwise the current chunk is finished and a new chunk starts. Each chunk keeps the first unit’s `startTime` and the last merged unit’s `endTime`.

5. **Output chunks and pending tail**  
   `chunkTranscript` returns `{ chunks: SpeakerSegment[], pendingTail: SemanticChunkingTail | null }`. All merged chunks **except the last** are in `chunks` and are passed to `processSegmentsCombined`. The last chunk is kept as **pending tail** (its units + embeddings) so the next batch can merge across the boundary. When `flushTail: true` (e.g. on recording stop), the tail is emitted as one chunk and `pendingTail` is null.

---

## Key types and modules

| Item                     | Location                                           | Description                                                                                                                                          |
| ------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TranscriptUnit**       | [src/types.ts](src/types.ts)                       | One sentence/phrase with `text`, `startTime`, `endTime`, `speakerTag`.                                                                               |
| **SemanticChunkingTail** | [src/types.ts](src/types.ts)                       | Pending tail: `units: TranscriptUnit[]`, `embeddings: number[][]`.                                                                                   |
| **chunkTranscript**      | [src/semanticChunking.ts](src/semanticChunking.ts) | Public API: `chunkTranscript(segments, options?)` → `Promise<{ chunks, pendingTail }>`. Options: `previousTail`, `flushTail`, `similarityThreshold`. |
| **embedTexts**           | [src/services/gemini.ts](src/services/gemini.ts)   | Embeds an array of strings with `gemini-embedding-001`; used by semantic chunking.                                                                   |

---

## Edge cases

- **Empty or single unit**  
  If splitting yields zero units, `chunkTranscript` returns `{ chunks: [], pendingTail: null }` (or keeps existing tail if no new segments). If there is one unit and no previous tail, it is kept as pending tail (with its embedding) so the next batch can merge.

- **All units below threshold**  
  No merging: each unit becomes its own one-unit chunk; the last is still kept as tail.

- **Embedding API failure**  
  If `embedTexts` throws, `chunkTranscript` catches, logs a warning, and falls back to treating each unit as its own chunk (no merging). Returns `pendingTail: null` so invalid state is not carried.

- **Embedding count mismatch**  
  If the number of returned embeddings does not match the number of units, the same fallback applies: each unit becomes a chunk; `pendingTail: null`.

- **Time bounds for chunks**  
  Each chunk’s `startTime` is the first unit’s `startTime` and `endTime` is the last merged unit’s `endTime`, so [speechAlignment.ts](src/speechAlignment.ts) and `findNearestContexts` get a sensible timestamp for comment placement.

- **Recording start**  
  The extension clears the pending tail when recording starts so a new session does not carry over state.

- **Recording stop**  
  After flushing any queued segments, the extension calls `chunkTranscript([], { previousTail, flushTail: true })` to emit the tail as one chunk, then posts GitHub comments.

---

## Config

The merge threshold is fixed at **0.75** in code ([src/semanticChunking.ts](src/semanticChunking.ts) `DEFAULT_SIMILARITY_THRESHOLD`). If a setting such as **`pr-notes.semanticChunkMergeThreshold`** is added later, it would be passed as `options.similarityThreshold` to `chunkTranscript` and documented here and in [DATAFLOW.md](DATAFLOW.md).

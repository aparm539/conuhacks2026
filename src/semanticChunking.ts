/**
 * Semantic transcript chunking: split transcript into sentence-level units,
 * compute similarity between neighbors via Gemini embeddings, merge related
 * units into chunks. Each chunk becomes one candidate PR comment.
 */

import type { SpeakerSegment, SemanticChunkingTail } from "./types";
import type { TranscriptUnit } from "./types";
import { embedTexts } from "./services/gemini";

export type { SemanticChunkingTail };

const DEFAULT_SIMILARITY_THRESHOLD = 0.75;

/** Split on sentence boundaries: . ? ! followed by space or end */
const SENTENCE_BOUNDARY = /[.?!]\s*|\n+/g;

/**
 * Split segment texts into sentence-level units with proportional time ranges.
 */
function splitSegmentsIntoUnits(segments: SpeakerSegment[]): TranscriptUnit[] {
  const units: TranscriptUnit[] = [];

  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) {
      continue;
    }
    const parts = text
      .split(SENTENCE_BOUNDARY)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    const duration = seg.endTime - seg.startTime;
    const totalChars = parts.reduce((sum, p) => sum + p.length, 0) || 1;
    let t = seg.startTime;
    for (const part of parts) {
      const span =
        totalChars > 0
          ? (part.length / totalChars) * duration
          : duration / parts.length;
      units.push({
        text: part,
        startTime: t,
        endTime: t + span,
        speakerTag: seg.speakerTag,
      });
      t += span;
    }
  }

  return units;
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface MergeResult {
  chunks: SpeakerSegment[];
  lastChunkUnitIndices: number[];
}

/**
 * Merge adjacent units that are above the similarity threshold into chunks.
 * Returns chunks and the unit indices that form the last chunk (for pending tail).
 */
function mergeUnitsBySimilarity(
  units: TranscriptUnit[],
  embeddings: number[][],
  threshold: number,
): MergeResult {
  if (units.length === 0) {
    return { chunks: [], lastChunkUnitIndices: [] };
  }
  if (units.length === 1) {
    const u = units[0];
    return {
      chunks: [
        {
          speakerTag: u.speakerTag,
          text: u.text,
          startTime: u.startTime,
          endTime: u.endTime,
        },
      ],
      lastChunkUnitIndices: [0],
    };
  }

  const chunks: SpeakerSegment[] = [];
  let chunkStart = units[0];
  let chunkText = chunkStart.text;
  let chunkEndTime = chunkStart.endTime;
  let currentChunkIndices: number[] = [0];

  for (let i = 1; i < units.length; i++) {
    const sim = cosineSimilarity(embeddings[i - 1], embeddings[i]);
    if (sim >= threshold) {
      chunkText += " " + units[i].text;
      chunkEndTime = units[i].endTime;
      currentChunkIndices.push(i);
    } else {
      chunks.push({
        speakerTag: chunkStart.speakerTag,
        text: chunkText.trim(),
        startTime: chunkStart.startTime,
        endTime: chunkEndTime,
      });
      chunkStart = units[i];
      chunkText = units[i].text;
      chunkEndTime = units[i].endTime;
      currentChunkIndices = [i];
    }
  }
  chunks.push({
    speakerTag: chunkStart.speakerTag,
    text: chunkText.trim(),
    startTime: chunkStart.startTime,
    endTime: chunkEndTime,
  });
  return { chunks, lastChunkUnitIndices: currentChunkIndices };
}

function tailToSegment(tail: SemanticChunkingTail): SpeakerSegment {
  const units = tail.units;
  if (units.length === 0) {
    return { speakerTag: 0, text: "", startTime: 0, endTime: 0 };
  }
  const first = units[0];
  const last = units[units.length - 1];
  const text = units
    .map((u) => u.text)
    .join(" ")
    .trim();
  return {
    speakerTag: first.speakerTag,
    text,
    startTime: first.startTime,
    endTime: last.endTime,
  };
}

export interface ChunkTranscriptResult {
  chunks: SpeakerSegment[];
  pendingTail: SemanticChunkingTail | null;
}

/**
 * Chunk transcript by meaning: split into units, embed, merge adjacent similar units.
 * Supports cross-batch state via previousTail; the last chunk is kept as pendingTail
 * unless flushTail is true. On recording stop, call with segments=[], previousTail set, flushTail=true to flush the tail.
 */
export async function chunkTranscript(
  segments: SpeakerSegment[],
  options?: {
    similarityThreshold?: number;
    previousTail?: SemanticChunkingTail | null;
    flushTail?: boolean;
  },
): Promise<ChunkTranscriptResult> {
  const threshold =
    options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const previousTail = options?.previousTail ?? null;
  const flushTail = options?.flushTail ?? false;

  // Flush tail only: no new segments, emit tail as one chunk
  if (segments.length === 0 && previousTail && flushTail) {
    return { chunks: [tailToSegment(previousTail)], pendingTail: null };
  }

  if (segments.length === 0 && !previousTail) {
    return { chunks: [], pendingTail: null };
  }

  const newUnits = splitSegmentsIntoUnits(segments);
  let allUnits: TranscriptUnit[];
  let allEmbeddings: number[][];

  if (previousTail) {
    allUnits = previousTail.units.concat(newUnits);
    if (newUnits.length === 0) {
      // No new content; keep tail as-is, emit nothing
      return { chunks: [], pendingTail: previousTail };
    }
    let newEmbeddings: number[][];
    try {
      newEmbeddings = await embedTexts(newUnits.map((u) => u.text));
    } catch (err) {
      console.warn(
        "[SemanticChunking] Embedding API failed, treating each unit as a chunk:",
        err instanceof Error ? err.message : err,
      );
      const fallback = allUnits.map((u) => ({
        speakerTag: u.speakerTag,
        text: u.text,
        startTime: u.startTime,
        endTime: u.endTime,
      }));
      return { chunks: fallback, pendingTail: null };
    }
    if (newEmbeddings.length !== newUnits.length) {
      console.warn(
        `[SemanticChunking] Embedding count mismatch (${newEmbeddings.length} vs ${newUnits.length}), treating each unit as a chunk`,
      );
      const fallback = allUnits.map((u) => ({
        speakerTag: u.speakerTag,
        text: u.text,
        startTime: u.startTime,
        endTime: u.endTime,
      }));
      return { chunks: fallback, pendingTail: null };
    }
    allEmbeddings = previousTail.embeddings.concat(newEmbeddings);
  } else {
    if (newUnits.length === 0) {
      return { chunks: [], pendingTail: null };
    }
    if (newUnits.length === 1) {
      const u = newUnits[0];
      try {
        const singleEmbedding = await embedTexts([u.text]);
        if (singleEmbedding.length === 1) {
          return {
            chunks: [],
            pendingTail: { units: [u], embeddings: singleEmbedding },
          };
        }
      } catch {
        // fall through to treat as chunk
      }
      return {
        chunks: [
          {
            speakerTag: u.speakerTag,
            text: u.text,
            startTime: u.startTime,
            endTime: u.endTime,
          },
        ],
        pendingTail: null,
      };
    }
    let embeddings: number[][];
    try {
      embeddings = await embedTexts(newUnits.map((u) => u.text));
    } catch (err) {
      console.warn(
        "[SemanticChunking] Embedding API failed, treating each unit as a chunk:",
        err instanceof Error ? err.message : err,
      );
      return {
        chunks: newUnits.map((u) => ({
          speakerTag: u.speakerTag,
          text: u.text,
          startTime: u.startTime,
          endTime: u.endTime,
        })),
        pendingTail: null,
      };
    }
    if (embeddings.length !== newUnits.length) {
      console.warn(
        `[SemanticChunking] Embedding count mismatch (${embeddings.length} vs ${newUnits.length}), treating each unit as a chunk`,
      );
      return {
        chunks: newUnits.map((u) => ({
          speakerTag: u.speakerTag,
          text: u.text,
          startTime: u.startTime,
          endTime: u.endTime,
        })),
        pendingTail: null,
      };
    }
    allUnits = newUnits;
    allEmbeddings = embeddings;
  }

  const { chunks, lastChunkUnitIndices } = mergeUnitsBySimilarity(
    allUnits,
    allEmbeddings,
    threshold,
  );

  if (flushTail) {
    return { chunks, pendingTail: null };
  }

  const pendingTail: SemanticChunkingTail = {
    units: lastChunkUnitIndices.map((i) => allUnits[i]),
    embeddings: lastChunkUnitIndices.map((i) => allEmbeddings[i]),
  };
  return {
    chunks: chunks.slice(0, -1),
    pendingTail,
  };
}

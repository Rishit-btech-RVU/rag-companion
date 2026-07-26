// Phase 7: the clip finder.
//
//   browseClips  - pure metadata filter over Chroma, no LLM call.
//   searchClips  - runs the full Phase 2-6 graph in "clip" mode, so a
//                  natural-language request ("find something funny about
//                  callbacks") gets turned into a single best clip pick
//                  instead of a factual answer.

import { getCollection } from "./config.js";
import { buildGraph, RECURSION_LIMIT } from "./graph.js";
import { EXACT_LOCATOR_SOURCE_TYPES } from "./lib/time.js";

const BROWSE_FETCH_CAP = 1000; // Chroma get() limit before we sort client-side

/**
 * Pure metadata filter query - no embeddings, no LLM call. Sorted by
 * categoryConfidence descending.
 */
export async function browseClips({ category, minConfidence, limit = 20 } = {}) {
  const collection = await getCollection();

  const conditions = [];
  if (category) conditions.push({ category: { $eq: category } });
  if (minConfidence !== undefined) conditions.push({ categoryConfidence: { $gte: minConfidence } });

  let where;
  if (conditions.length === 1) where = conditions[0];
  else if (conditions.length > 1) where = { $and: conditions };

  const result = await collection.get({ where, limit: BROWSE_FETCH_CAP, include: ["metadatas"] });

  return result.metadatas
    .sort((a, b) => b.categoryConfidence - a.categoryConfidence)
    .slice(0, limit);
}

/**
 * Full graph run in "clip" mode: retrieval/rerank/grade/guardrail all reuse
 * the Phase 2-6 pipeline, but `generate` returns a single clip pick instead
 * of a factual answer. lessonName/videoId are attached from the winning
 * ranked chunk - the bare {category, startTime, endTime, pitch} shape on its
 * own isn't enough to know which video to actually cut the clip from.
 */
export async function searchClips({ query }) {
  const graph = buildGraph({ mode: "clip" });
  const result = await graph.invoke({ query, mode: "clip" }, { recursionLimit: RECURSION_LIMIT });

  const clip = JSON.parse(result.response);
  const sourceChunk = result.rankedDocs.find((d) => {
    const tolerance = EXACT_LOCATOR_SOURCE_TYPES.has(d.sourceType) ? 0 : 5;
    return clip.startTime >= d.startTime - tolerance && clip.endTime <= d.endTime + tolerance;
  });

  return {
    ...clip,
    lessonName: sourceChunk?.lessonName ?? null,
    videoId: sourceChunk?.videoId ?? null,
    sourceType: sourceChunk?.sourceType ?? null,
    sourceText: sourceChunk?.text ?? null,
    trace: result.trace,
  };
}

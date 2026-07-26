// Lists the distinct ingested sources (lessons/docs) backing the collection,
// for a NotebookLM-style "Sources" panel. Metadata-only, no LLM call - same
// style as clips.js's browseClips.

import { getCollection } from "./config.js";

const LIST_FETCH_CAP = 5000; // Chroma get() limit before we group client-side

/** Group every chunk's metadata by its source (stored under the `videoId` field). */
export async function listSources() {
  const collection = await getCollection();
  const result = await collection.get({ limit: LIST_FETCH_CAP, include: ["metadatas"] });

  const bySourceId = new Map();
  for (const meta of result.metadatas) {
    const existing = bySourceId.get(meta.videoId);
    if (existing) {
      existing.chunkCount += 1;
    } else {
      bySourceId.set(meta.videoId, {
        sourceId: meta.videoId,
        lessonName: meta.lessonName,
        sourceType: meta.sourceType,
        chunkCount: 1,
      });
    }
  }

  return [...bySourceId.values()].sort((a, b) => a.lessonName.localeCompare(b.lessonName));
}

/** Delete every chunk belonging to one source (identified by the stable `videoId` field). */
export async function deleteSource(sourceId) {
  const collection = await getCollection();
  await collection.delete({ where: { videoId: sourceId } });
}

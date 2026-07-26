// Plain-text source ingestion. There's no natural page or timestamp for
// pasted text, so chunks are cited by a section number instead - each chunk
// is a run of paragraphs kept under a target character count, broken at
// paragraph boundaries so a chunk never splits a paragraph in half.

import { ingestChunks } from "./ingest.js";

const CHUNK_TARGET_CHARS = 800;

/** Turn raw pasted text into the common { startTime, endTime, text } chunk shape. */
export function chunkPlainText(text) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";
  let index = 0;

  function push() {
    if (!current.trim()) return;
    index += 1;
    chunks.push({ startTime: index, endTime: index, text: current.trim() });
    current = "";
  }

  for (const para of paragraphs) {
    if (current && current.length + para.length > CHUNK_TARGET_CHARS) push();
    current += (current ? "\n\n" : "") + para;
  }
  push();

  return chunks;
}

/** Ingest raw pasted text. */
export async function ingestPlainText({ text, lessonName, sourceId, collection }) {
  const chunks = chunkPlainText(text);
  const chunksIngested = await ingestChunks({ chunks, lessonName, sourceId, sourceType: "text", collection });
  return { chunksIngested, sourceId };
}

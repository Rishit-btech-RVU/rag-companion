// YouTube source ingestion. Uses only a video's *existing* captions
// (auto-generated or manual) via an unofficial scraping library - no audio
// download or speech-to-text, per this project's "no STT" constraint. Videos
// with captions disabled/unavailable will throw and surface as a clear error.

import { fetchTranscript } from "youtube-transcript";
import { mergeCuesIntoChunks, ingestChunks } from "./ingest.js";

/** Accepts a full YouTube URL (watch/short/embed) or a bare video id. */
export function extractYoutubeVideoId(urlOrId) {
  try {
    const url = new URL(urlOrId);
    if (url.hostname.includes("youtu.be")) return url.pathname.slice(1);
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    const embedMatch = url.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/);
    if (embedMatch) return embedMatch[1];
  } catch {
    // Not a parseable URL - assume the caller already passed a bare video id.
  }
  return urlOrId;
}

export async function ingestYoutubeUrl({ url, lessonName, collection }) {
  const videoId = extractYoutubeVideoId(url);
  const transcript = await fetchTranscript(videoId);

  const cues = transcript
    .map((t) => ({
      startMs: t.offset,
      endMs: t.offset + t.duration,
      text: t.text.replace(/\s+/g, " ").trim(),
    }))
    .filter((c) => c.text.length > 0);

  const chunks = mergeCuesIntoChunks(cues);
  const sourceId = `yt-${videoId}`;
  const resolvedLessonName = lessonName?.trim() || `YouTube video ${videoId}`;

  const chunksIngested = await ingestChunks({
    chunks,
    lessonName: resolvedLessonName,
    sourceId,
    sourceType: "youtube",
    collection,
  });

  return { chunksIngested, sourceId, lessonName: resolvedLessonName };
}

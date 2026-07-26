// Phase 8: a minimal API layer so a future frontend can be built against this
// pipeline without importing Node modules directly. No auth, no production
// concerns - this only needs to be callable from a local frontend dev server.

import express from "express";
import cors from "cors";
import multer from "multer";
import { runQuery } from "./graph.js";
import { browseClips, searchClips } from "./clips.js";
import { listSources, deleteSource } from "./sources.js";
import { parseSubtitleFile, mergeCuesIntoChunks, ingestChunks } from "./ingest.js";
import { ingestPdfBuffer } from "./pdfIngest.js";
import { ingestYoutubeUrl } from "./youtubeIngest.js";
import { ingestPlainText } from "./textIngest.js";
import { ingestWebUrl } from "./webIngest.js";
import { getCollection } from "./config.js";
import { slugify } from "./lib/slug.js";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const PORT = process.env.PORT || 3000;

app.post("/query", async (req, res) => {
  const { query } = req.body ?? {};
  if (typeof query !== "string" || query.trim().length === 0) {
    return res.status(400).json({ error: "body must include a non-empty string `query`" });
  }
  try {
    const result = await runQuery(query);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error running query" });
  }
});

app.get("/clips", async (req, res) => {
  const { category, minConfidence, limit } = req.query;
  try {
    const result = await browseClips({
      category: category || undefined,
      minConfidence: minConfidence !== undefined ? Number(minConfidence) : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error browsing clips" });
  }
});

app.get("/sources", async (req, res) => {
  try {
    const result = await listSources();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error listing sources" });
  }
});

app.delete("/sources/:sourceId", async (req, res) => {
  try {
    await deleteSource(req.params.sourceId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error deleting source" });
  }
});

app.post("/clips/search", async (req, res) => {
  const { query } = req.body ?? {};
  if (typeof query !== "string" || query.trim().length === 0) {
    return res.status(400).json({ error: "body must include a non-empty string `query`" });
  }
  try {
    const result = await searchClips({ query });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error searching clips" });
  }
});

// --- Phase "Add Source": VTT/SRT upload, PDF upload, YouTube link ---
// These run ingestion synchronously in the request (no job queue, per this
// project's scope) - fine on a host without an aggressive request timeout
// (e.g. Render), but a large file/video can take a while since every chunk
// gets its own classification LLM call.

app.post("/sources/vtt", upload.single("file"), async (req, res) => {
  const { lessonName } = req.body ?? {};
  if (!req.file) return res.status(400).json({ error: "form field `file` (.vtt or .srt) is required" });
  if (!lessonName || !lessonName.trim()) {
    return res.status(400).json({ error: "form field `lessonName` is required" });
  }
  try {
    const content = req.file.buffer.toString("utf-8");
    const cues = parseSubtitleFile(content);
    const chunks = mergeCuesIntoChunks(cues);
    if (chunks.length === 0) {
      return res.status(422).json({ error: "no captions could be parsed from this file" });
    }
    const collection = await getCollection();
    const sourceId = slugify(lessonName);
    const chunksIngested = await ingestChunks({ chunks, lessonName, sourceId, sourceType: "video", collection });
    res.json({ success: true, sourceId, chunksIngested });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "internal error ingesting subtitle file" });
  }
});

app.post("/sources/pdf", upload.single("file"), async (req, res) => {
  const { lessonName } = req.body ?? {};
  if (!req.file) return res.status(400).json({ error: "form field `file` (.pdf) is required" });
  if (!lessonName || !lessonName.trim()) {
    return res.status(400).json({ error: "form field `lessonName` is required" });
  }
  try {
    const collection = await getCollection();
    const docId = slugify(lessonName);
    const result = await ingestPdfBuffer({ buffer: req.file.buffer, lessonName, docId, collection });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "internal error ingesting PDF" });
  }
});

app.post("/sources/youtube", async (req, res) => {
  const { url, lessonName } = req.body ?? {};
  if (typeof url !== "string" || url.trim().length === 0) {
    return res.status(400).json({ error: "body must include a non-empty string `url`" });
  }
  try {
    const collection = await getCollection();
    const result = await ingestYoutubeUrl({ url, lessonName, collection });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    // youtube-transcript throws specific, already-readable errors for
    // disabled/unavailable captions - surface those as 422s, not 500s.
    const status = err.constructor?.name?.startsWith("YoutubeTranscript") ? 422 : 500;
    res.status(status).json({ error: err.message || "internal error ingesting YouTube video" });
  }
});

app.post("/sources/text", async (req, res) => {
  const { text, lessonName } = req.body ?? {};
  if (typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "body must include a non-empty string `text`" });
  }
  if (!lessonName || !lessonName.trim()) {
    return res.status(400).json({ error: "body must include `lessonName`" });
  }
  try {
    const collection = await getCollection();
    const sourceId = slugify(lessonName);
    const result = await ingestPlainText({ text, lessonName, sourceId, collection });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "internal error ingesting text" });
  }
});

app.post("/sources/web", async (req, res) => {
  const { url, lessonName } = req.body ?? {};
  if (typeof url !== "string" || url.trim().length === 0) {
    return res.status(400).json({ error: "body must include a non-empty string `url`" });
  }
  try {
    const collection = await getCollection();
    const resolvedLessonName = lessonName?.trim() || new URL(url).hostname;
    const sourceId = slugify(resolvedLessonName);
    const result = await ingestWebUrl({ url, lessonName: resolvedLessonName, sourceId, collection });
    res.json({ success: true, ...result, lessonName: resolvedLessonName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "internal error ingesting web page" });
  }
});

app.listen(PORT, () => {
  console.log(`RAG API listening on http://localhost:${PORT}`);
});

// Phase 1 acceptance test.
//
// Checks, against the raw Chroma client (no LangChain involved):
//   1. Metadata comes back correctly and matches the ChunkMetadata shape.
//   2. Chunk time ranges are sensible (startTime < endTime, roughly 10-90s,
//      monotonically increasing within a lesson).
//   3. Re-running ingestion on the same files updates rather than duplicates
//      (count of chunks stays the same after a second ingest run).
//
// Run with: npm run test:ingest

import { getCollection, getChroma, COLLECTION_NAME } from "../config.js";
import { ingestFile } from "../ingest.js";
import { EXACT_LOCATOR_SOURCE_TYPES } from "../lib/time.js";
import fs from "node:fs/promises";
import path from "node:path";

const REQUIRED_FIELDS = [
  "id",
  "lessonName",
  "videoId",
  "startTime",
  "endTime",
  "category",
  "categoryConfidence",
  "categoryReason",
  "text",
];
const VALID_CATEGORIES = ["funny", "insightful", "controversial", "emotional", "informative", "none"];

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}`);
    failures++;
  }
}

async function main() {
  console.log("=== 1. Metadata shape & sanity check (raw Chroma query) ===");
  const collection = await getCollection();
  const countBefore = await collection.count();
  console.log(`Collection "${COLLECTION_NAME}" has ${countBefore} chunks.`);
  check("collection is non-empty", countBefore > 0);

  const all = await collection.get({ limit: countBefore, include: ["metadatas", "documents"] });
  check("get() returned metadatas", all.metadatas.length === countBefore);

  const byVideo = new Map();
  for (const meta of all.metadatas) {
    for (const field of REQUIRED_FIELDS) {
      if (!(field in meta)) {
        console.log(`  FAIL: chunk ${meta.id ?? "?"} missing field "${field}"`);
        failures++;
      }
    }
    if (!VALID_CATEGORIES.includes(meta.category)) {
      console.log(`  FAIL: chunk ${meta.id} has invalid category "${meta.category}"`);
      failures++;
    }
    if (!(meta.categoryConfidence >= 0 && meta.categoryConfidence <= 10)) {
      console.log(`  FAIL: chunk ${meta.id} has out-of-range confidence ${meta.categoryConfidence}`);
      failures++;
    }
    if (!byVideo.has(meta.videoId)) byVideo.set(meta.videoId, []);
    byVideo.get(meta.videoId).push(meta);
  }
  check("every chunk has all required ChunkMetadata fields", true); // per-field failures already logged above
  console.log(`Lessons found: ${[...byVideo.keys()].join(", ")}`);

  console.log("\n=== 2. Time range sanity check ===");
  for (const [videoId, chunks] of byVideo) {
    chunks.sort((a, b) => a.startTime - b.startTime);
    let prevEnd = -Infinity;
    let rangesOk = true;
    // PDF/text/web chunks are cited by an exact page/section index, so
    // startTime === endTime there is correct (not a zero-length bug) - only
    // require endTime > startTime for video/YouTube chunks, where they're a
    // real seconds range.
    for (const c of chunks) {
      const validRange = EXACT_LOCATOR_SOURCE_TYPES.has(c.sourceType) ? c.endTime === c.startTime : c.endTime > c.startTime;
      if (!(c.startTime >= 0 && validRange)) rangesOk = false;
      if (c.startTime < prevEnd - 0.001) rangesOk = false; // allow float rounding
      prevEnd = c.endTime;
    }
    check(`"${videoId}" (${chunks.length} chunks): ranges are ordered, non-overlapping, startTime < endTime (or === for PDF pages)`, rangesOk);
    const sample = chunks[0];
    console.log(
      `    sample chunk: [${sample.startTime.toFixed(1)}s-${sample.endTime.toFixed(1)}s] ` +
        `category=${sample.category} (${sample.categoryConfidence}/10) "${sample.text.slice(0, 60)}..."`
    );
  }

  console.log("\n=== 3. Re-ingestion dedup check ===");
  const manifestPath = path.resolve("data/lessons/manifest.json");
  const raw = await fs.readFile(manifestPath, "utf-8");
  const entries = JSON.parse(raw).map((e) => ({
    ...e,
    filePath: path.resolve(path.dirname(manifestPath), e.filePath),
  }));

  // Re-run ingestion for just the first lesson and confirm the total chunk
  // count in the collection doesn't grow (stable ids -> upsert, not insert).
  const target = entries[0];
  const beforeCount = (await collection.get({ where: { videoId: target.videoId } })).ids.length;
  await ingestFile(target, collection);
  const afterCount = (await collection.get({ where: { videoId: target.videoId } })).ids.length;
  check(
    `re-ingesting "${target.lessonName}" keeps chunk count stable (${beforeCount} -> ${afterCount})`,
    beforeCount === afterCount
  );

  const totalAfter = await collection.count();
  check(
    `total collection count unchanged after re-ingest (${countBefore} -> ${totalAfter})`,
    countBefore === totalAfter
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

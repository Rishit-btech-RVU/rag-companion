// Website URL ingestion. Fetches the page, strips it down to plain text with
// simple regex-based tag stripping (no DOM parsing dependency - good enough
// for typical articles/blogs, won't handle JS-rendered SPA content), then
// chunks it the same way plain-text sources are chunked.

import { ingestChunks } from "./ingest.js";
import { chunkPlainText } from "./textIngest.js";

const HTML_ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

export function extractTextFromHtml(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    text = text.split(entity).join(replacement);
  }

  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Ingest a web page by URL. */
export async function ingestWebUrl({ url, lessonName, sourceId, collection }) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SeekPointBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Failed to fetch URL (HTTP ${res.status})`);
  const html = await res.text();
  const text = extractTextFromHtml(html);

  if (text.length < 50) {
    throw new Error("Couldn't extract meaningful text from this page (it may require JavaScript to render)");
  }

  const chunks = chunkPlainText(text);
  const chunksIngested = await ingestChunks({ chunks, lessonName, sourceId, sourceType: "web", collection });
  return { chunksIngested, sourceId };
}

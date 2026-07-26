/** Format a seconds count as mm:ss for citations. */
export function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

// Source types whose startTime/endTime are an exact index (a page or section
// number) rather than a seconds range - so startTime === endTime is correct
// (not a zero-length bug), and "close enough" matching needs 0 slack instead
// of the +-5 seconds that makes sense for video/YouTube chunks.
export const EXACT_LOCATOR_SOURCE_TYPES = new Set(["pdf", "text", "web"]);

/**
 * A chunk's citable "locator": a mm:ss range for video/YouTube sources, a
 * page number for PDFs, or a section number for plain-text/web sources
 * (where startTime === endTime === the section index - there's no natural
 * page or timestamp for pasted text or a web page).
 */
export function formatLocator(chunk) {
  if (chunk.sourceType === "pdf") return `p. ${chunk.startTime}`;
  if (chunk.sourceType === "text" || chunk.sourceType === "web") return `§${chunk.startTime}`;
  return `${formatTimestamp(chunk.startTime)}-${formatTimestamp(chunk.endTime)}`;
}

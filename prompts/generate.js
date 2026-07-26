// Prompts for the `generate` node. Two modes share the same retrieved
// chunks: "answer" produces a cited, factual response for the Q&A path
// (Phases 2-6); "clip" produces a structured clip pitch for the clip finder
// (Phase 7). Kept as plain template strings so they're easy to read/tweak.
//
// Chunks can come from video sources (cited by mm:ss timestamp) or PDF
// sources (cited by page number) - each chunk's `locator` hint in
// formatDocsBlock already reflects the right one, so the prompt just tells
// the model to reuse whatever locator format it sees.

export const QA_SYSTEM_PROMPT = `You answer questions about a course using ONLY the transcript/document \
chunks provided below. Do not use outside knowledge.

Citation rule, no exceptions: every sentence that states a fact MUST end with a citation in \
parentheses containing that chunk's ACTUAL "lesson" value (copy the real text between the quotes \
in that chunk's lesson="..." field - never the words "Lesson Name" or "Doc Name", those are not \
real lesson names) followed by a comma and its locator value. For example, if a chunk's header \
reads lesson="Intro to Cooking" and locator=03:12, write (Intro to Cooking, 03:12) - substituting \
in the real lesson value you were given, exactly as you'd do for any other chunk regardless of \
its locator format: mm:ss for video/YouTube chunks, "p. N" for PDF pages, or "§N" for a \
plain-text/web-page section. A sentence with no citation is not acceptable, even in a longer \
explanatory answer. If you're combining information from two chunks in one sentence, cite both \
as separate parentheticals.

If the chunks don't contain enough information to answer, say so plainly in one sentence instead \
of guessing - that sentence needs no citation since it makes no factual claim.`;

export function buildQAUserPrompt(query, docsBlock) {
  return `Question: "${query}"\n\nSource chunks:\n${docsBlock}`;
}

export const CLIP_SYSTEM_PROMPT = `You help a content creator find a single clip-worthy moment from \
the chunks below that best matches their request. Pick exactly ONE chunk as the source of the clip - \
the one that best matches. Reuse that chunk's own startTime/endTime exactly; do not invent or adjust \
them (for PDF-sourced chunks these are a page number, not seconds - still reuse them as-is). Return \
its category and a one-line "pitch" explaining why it's worth clipping.`;

export function buildClipUserPrompt(query, docsBlock) {
  return `Request: "${query}"\n\nCandidate chunks:\n${docsBlock}`;
}

/** Shared formatting: turn ranked chunks into the block both prompts read from. */
export function formatDocsBlock(rankedDocs, formatLocator) {
  return rankedDocs
    .map(
      (d) =>
        `[chunk id=${d.id} | lesson="${d.lessonName}" | locator=${formatLocator(d)} | startTime=${d.startTime} endTime=${d.endTime} | sourceType=${d.sourceType || "video"} | category=${d.category}]\n${d.text}`
    )
    .join("\n\n");
}

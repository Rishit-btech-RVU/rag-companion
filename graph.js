// Phases 2-6: the LangGraph query pipeline.
//
//   transform -> retrieve -> merge -> rerank -> generate -> grade -> [retry -> transform]* -> guardrail -> END
//
// `buildGraph({ mode })` compiles the graph for either the Q&A path
// ("answer", the default) or the clip-finder path ("clip", Phase 7's
// searchClips). Both modes share every node; only `generate`'s prompt (and
// `guardrail`'s validation) branch on `mode`.
//
// Every node appends one entry to `state.trace` (Phase 6) so a future UI can
// render what the pipeline did step by step, including retries.

import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { getOpenAI, getCollection, EMBEDDING_MODEL, CHAT_MODEL } from "./config.js";
import { formatLocator, EXACT_LOCATOR_SOURCE_TYPES } from "./lib/time.js";
import { TRANSFORM_SYSTEM_PROMPT, buildTransformUserPrompt } from "./prompts/transform.js";
import { RERANK_SYSTEM_PROMPT, buildRerankUserPrompt } from "./prompts/rerank.js";
import {
  QA_SYSTEM_PROMPT,
  buildQAUserPrompt,
  CLIP_SYSTEM_PROMPT,
  buildClipUserPrompt,
  formatDocsBlock,
} from "./prompts/generate.js";
import { GRADE_SYSTEM_PROMPT, buildGradeUserPrompt } from "./prompts/grade.js";

const RETRIEVE_N_PER_VARIANT = 30;
const RERANK_CANDIDATE_CAP = 40;
const RERANK_KEEP_TOP = 5;
export const GRADE_PASS_THRESHOLD = 6;
export const MAX_RETRIES = 3;

const CATEGORIES = ["funny", "insightful", "controversial", "emotional", "informative", "none"];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const overwrite = () => ({ reducer: (_left, right) => right, default: () => undefined });
const append = () => ({ reducer: (left, right) => left.concat(right), default: () => [] });

export const RagState = Annotation.Root({
  query: Annotation(overwrite()),
  mode: Annotation({ reducer: (_l, r) => r, default: () => "answer" }), // "answer" | "clip"

  // transform output
  subQueries: Annotation({ reducer: (_l, r) => r, default: () => [] }),
  hydeDoc: Annotation(overwrite()),
  variants: Annotation({ reducer: (_l, r) => r, default: () => [] }), // internal: [{type, text}]

  // retrieve/merge output
  candidateDocs: Annotation({ reducer: (_l, r) => r, default: () => [] }), // internal, raw+duplicated
  retrievedDocs: Annotation({ reducer: (_l, r) => r, default: () => [] }), // merged, deduped
  rankedDocs: Annotation({ reducer: (_l, r) => r, default: () => [] }), // top 5 after rerank

  response: Annotation(overwrite()),
  score: Annotation(overwrite()),
  scoreHistory: Annotation(append()),
  feedback: Annotation(overwrite()),
  retryCount: Annotation({ reducer: (_l, r) => r, default: () => 0 }),

  trace: Annotation(append()),
});

function traceStep(node, summary, data) {
  return { node, summary, data, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// transform
// ---------------------------------------------------------------------------

const TransformSchema = z.object({
  hydeAnswer: z.string(),
  isCompound: z.boolean(),
  subQueries: z.array(z.string()).max(3),
});

async function transformNode(state) {
  const openai = getOpenAI();
  const completion = await openai.chat.completions.parse({
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: TRANSFORM_SYSTEM_PROMPT },
      { role: "user", content: buildTransformUserPrompt(state.query, state.feedback) },
    ],
    response_format: zodResponseFormat(TransformSchema, "query_transform"),
  });
  const parsed = completion.choices[0].message.parsed;

  const variants = [{ type: "original", text: state.query }];
  variants.push({ type: "hyde", text: parsed.hydeAnswer });
  if (parsed.isCompound && parsed.subQueries.length > 0) {
    for (const sq of parsed.subQueries) variants.push({ type: "subquery", text: sq });
  }

  return {
    subQueries: parsed.subQueries,
    hydeDoc: parsed.hydeAnswer,
    variants,
    trace: [
      traceStep(
        "transform",
        `Prepared ${variants.length} retrieval variant(s)${state.feedback ? " (retry, using prior feedback)" : ""}`,
        { variants: variants.map((v) => v.type), isCompound: parsed.isCompound }
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// retrieve (per variant, in parallel)
// ---------------------------------------------------------------------------

async function retrieveNode(state) {
  const openai = getOpenAI();
  const collection = await getCollection();

  const embeddingResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: state.variants.map((v) => v.text),
  });
  const embeddings = embeddingResponse.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);

  const perVariantResults = await Promise.all(
    state.variants.map(async (variant, i) => {
      const result = await collection.query({
        queryEmbeddings: [embeddings[i]],
        nResults: RETRIEVE_N_PER_VARIANT,
        include: ["metadatas", "distances", "documents"],
      });
      const rows = result.rows()[0] ?? [];
      return rows.map((row) => ({
        ...row.metadata,
        text: row.document,
        distance: row.distance,
        sourceVariant: variant.type,
      }));
    })
  );

  const candidateDocs = perVariantResults.flat();

  return {
    candidateDocs,
    trace: [
      traceStep("retrieve", `Retrieved ${candidateDocs.length} raw candidate(s) across ${state.variants.length} variant(s)`, {
        perVariantCounts: perVariantResults.map((r, i) => ({ variant: state.variants[i].type, count: r.length })),
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// merge (dedupe by id, keep best distance)
// ---------------------------------------------------------------------------

function mergeNode(state) {
  const byId = new Map();
  for (const doc of state.candidateDocs) {
    const existing = byId.get(doc.id);
    if (!existing || doc.distance < existing.distance) {
      byId.set(doc.id, doc);
    }
  }
  const retrievedDocs = [...byId.values()].sort((a, b) => a.distance - b.distance);

  return {
    retrievedDocs,
    trace: [
      traceStep("merge", `Deduplicated ${state.candidateDocs.length} candidate(s) down to ${retrievedDocs.length} unique chunk(s)`, {
        uniqueCount: retrievedDocs.length,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// rerank (LLM scores every unique candidate against the ORIGINAL query)
// ---------------------------------------------------------------------------

const RerankSchema = z.object({
  scores: z.array(z.object({ id: z.string(), score: z.number().min(0).max(10) })),
});

async function rerankNode(state) {
  const openai = getOpenAI();
  const candidates = state.retrievedDocs.slice(0, RERANK_CANDIDATE_CAP);

  if (candidates.length === 0) {
    return { rankedDocs: [], trace: [traceStep("rerank", "No candidates to rerank", {})] };
  }

  const completion = await openai.chat.completions.parse({
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: RERANK_SYSTEM_PROMPT },
      { role: "user", content: buildRerankUserPrompt(state.query, candidates) },
    ],
    response_format: zodResponseFormat(RerankSchema, "rerank_scores"),
  });
  const parsed = completion.choices[0].message.parsed;

  const scoreById = new Map(parsed.scores.map((s) => [s.id, s.score]));
  const rankedDocs = candidates
    .map((doc) => ({ ...doc, relevanceScore: scoreById.get(doc.id) ?? 0 }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, RERANK_KEEP_TOP);

  return {
    rankedDocs,
    trace: [
      traceStep("rerank", `Scored ${candidates.length} candidate(s), kept top ${rankedDocs.length}`, {
        kept: rankedDocs.map((d) => ({ id: d.id, score: d.relevanceScore })),
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

const ClipResultSchema = z.object({
  category: z.enum(CATEGORIES),
  startTime: z.number(),
  endTime: z.number(),
  pitch: z.string(),
});

async function generateNode(state) {
  const openai = getOpenAI();
  const docsBlock = formatDocsBlock(state.rankedDocs, formatLocator);

  if (state.mode === "clip") {
    const completion = await openai.chat.completions.parse({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: CLIP_SYSTEM_PROMPT },
        { role: "user", content: buildClipUserPrompt(state.query, docsBlock) },
      ],
      response_format: zodResponseFormat(ClipResultSchema, "clip_result"),
    });
    const parsed = completion.choices[0].message.parsed;
    return {
      response: JSON.stringify(parsed),
      trace: [traceStep("generate", `Generated clip pitch (category=${parsed.category})`, { clip: parsed })],
    };
  }

  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: QA_SYSTEM_PROMPT },
      { role: "user", content: buildQAUserPrompt(state.query, docsBlock) },
    ],
  });
  const response = completion.choices[0].message.content;

  return {
    response,
    trace: [traceStep("generate", "Generated answer from ranked chunks", { responsePreview: response.slice(0, 120) })],
  };
}

// ---------------------------------------------------------------------------
// grade (CRAG) - Phase 4
// ---------------------------------------------------------------------------

const GradeSchema = z.object({
  score: z.number().min(0).max(10),
  feedback: z.string(),
});

async function gradeNode(state) {
  const openai = getOpenAI();
  const completion = await openai.chat.completions.parse({
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: GRADE_SYSTEM_PROMPT },
      { role: "user", content: buildGradeUserPrompt(state.query, state.response, state.rankedDocs) },
    ],
    response_format: zodResponseFormat(GradeSchema, "grade_result"),
  });
  const parsed = completion.choices[0].message.parsed;

  return {
    score: parsed.score,
    scoreHistory: [parsed.score],
    feedback: parsed.feedback,
    trace: [
      traceStep("grade", `Scored response ${parsed.score}/10`, {
        score: parsed.score,
        feedback: parsed.feedback,
        retryCount: state.retryCount,
      }),
    ],
  };
}

export function routeAfterGrade(state) {
  if (state.score < GRADE_PASS_THRESHOLD && state.retryCount < MAX_RETRIES) return "retry";
  return "guardrail";
}

export function retryNode(state) {
  const nextRetryCount = state.retryCount + 1;
  return {
    retryCount: nextRetryCount,
    trace: [traceStep("retry", `Score ${state.score}/10 below threshold, retry ${nextRetryCount}/${MAX_RETRIES}`, { feedback: state.feedback })],
  };
}

// ---------------------------------------------------------------------------
// guardrail - Phase 5
// ---------------------------------------------------------------------------

const TIMESTAMP_RE = /\b\d{1,2}:\d{2}\b/;
const PAGE_CITATION_RE = /\bp(?:age|g)?\.?\s?\d+\b/i;
const SECTION_CITATION_RE = /§\s?\d+/;
// Heuristic "sensitive content" patterns this course-QA bot should never echo:
// API-key-looking tokens, SSNs, and credit-card-looking digit runs.
const SENSITIVE_PATTERNS = [/\bsk-[A-Za-z0-9]{16,}\b/, /\b\d{3}-\d{2}-\d{4}\b/, /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/];

const QA_FALLBACK = "I don't have a grounded, citation-backed answer for that based on the ingested lessons.";
const CLIP_FALLBACK = JSON.stringify({
  category: "none",
  startTime: 0,
  endTime: 0,
  pitch: "No confidently clip-worthy moment was found for this request.",
});

export function checkGuardrail(state) {
  const containsSensitive = SENSITIVE_PATTERNS.some((re) => re.test(state.response));
  if (containsSensitive) return { ok: false, reason: "response contains a sensitive-looking pattern" };

  if (state.mode === "clip") {
    let parsed;
    try {
      parsed = JSON.parse(state.response);
    } catch {
      return { ok: false, reason: "clip response was not valid JSON" };
    }
    const result = ClipResultSchema.safeParse(parsed);
    if (!result.success) return { ok: false, reason: "clip response did not match the expected shape" };
    const withinAnyChunk = state.rankedDocs.some((d) => {
      const tolerance = EXACT_LOCATOR_SOURCE_TYPES.has(d.sourceType) ? 0 : 5;
      return parsed.startTime >= d.startTime - tolerance && parsed.endTime <= d.endTime + tolerance;
    });
    if (!withinAnyChunk) return { ok: false, reason: "clip timestamps don't fall within any ranked chunk" };
    return { ok: true };
  }

  const hasTimestamp =
    TIMESTAMP_RE.test(state.response) || PAGE_CITATION_RE.test(state.response) || SECTION_CITATION_RE.test(state.response);
  const hasLessonMention = state.rankedDocs.some((d) =>
    state.response.toLowerCase().includes(d.lessonName.toLowerCase())
  );
  if (!hasTimestamp || !hasLessonMention) {
    return { ok: false, reason: "response is missing a lesson name + timestamp citation" };
  }
  return { ok: true };
}

function guardrailNode(state) {
  const result = checkGuardrail(state);
  if (result.ok) {
    return { trace: [traceStep("guardrail", "Passed: citation present, no sensitive content", {})] };
  }
  const fallback = state.mode === "clip" ? CLIP_FALLBACK : QA_FALLBACK;
  return {
    response: fallback,
    trace: [traceStep("guardrail", `Failed (${result.reason}), returned fallback response`, { reason: result.reason })],
  };
}

// ---------------------------------------------------------------------------
// Graph assembly
// ---------------------------------------------------------------------------

let compiledAnswerGraph;
let compiledClipGraph;

export function buildGraph({ mode = "answer" } = {}) {
  if (mode === "answer" && compiledAnswerGraph) return compiledAnswerGraph;
  if (mode === "clip" && compiledClipGraph) return compiledClipGraph;

  const graph = new StateGraph(RagState)
    .addNode("transform", transformNode)
    .addNode("retrieve", retrieveNode)
    .addNode("merge", mergeNode)
    .addNode("rerank", rerankNode)
    .addNode("generate", generateNode)
    .addNode("grade", gradeNode)
    .addNode("retry", retryNode)
    .addNode("guardrail", guardrailNode)
    .addEdge(START, "transform")
    .addEdge("transform", "retrieve")
    .addEdge("retrieve", "merge")
    .addEdge("merge", "rerank")
    .addEdge("rerank", "generate")
    .addEdge("generate", "grade")
    .addConditionalEdges("grade", routeAfterGrade, { retry: "retry", guardrail: "guardrail" })
    .addEdge("retry", "transform")
    .addEdge("guardrail", END)
    .compile();

  if (mode === "answer") compiledAnswerGraph = graph;
  else compiledClipGraph = graph;
  return graph;
}

// Worst case is (MAX_RETRIES + 1) full attempts (transform..grade = 6 steps
// each) plus up to MAX_RETRIES "retry" hops plus a final "guardrail" step.
// LangGraph's default recursionLimit (25) is too low for MAX_RETRIES=3, so
// every invocation below sets it explicitly with headroom.
export const RECURSION_LIMIT = 6 * (MAX_RETRIES + 1) + MAX_RETRIES + 10;

/** Phase 2-6 entry point: ask a question, get a cited answer + full trace. */
export async function runQuery(query) {
  const graph = buildGraph({ mode: "answer" });
  const result = await graph.invoke({ query, mode: "answer" }, { recursionLimit: RECURSION_LIMIT });
  const sources = result.rankedDocs.map((d) => ({
    lessonName: d.lessonName,
    locator: formatLocator(d),
    text: d.text,
    sourceType: d.sourceType,
    // Lets the frontend build a "jump to this exact moment" link for
    // YouTube sources specifically (videoId is stored as `yt-<id>`).
    youtubeVideoId: d.sourceType === "youtube" ? d.videoId?.replace(/^yt-/, "") : undefined,
    startTime: d.startTime,
  }));
  return { response: result.response, trace: result.trace, sources };
}

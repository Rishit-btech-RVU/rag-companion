// Shared configuration: model names and client factories, kept in one place
// so every phase (ingest, graph, clips) references the same setup.

import "dotenv/config";
import OpenAI from "openai";
import { ChromaClient } from "chromadb";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const CHAT_MODEL = "gpt-4o-mini";

export const COLLECTION_NAME = "course_chunks";

// Chunk target length when merging subtitle cues (Phase 1).
export const CHUNK_MIN_SECONDS = 30;
export const CHUNK_MAX_SECONDS = 60;

let openaiClient;
export function getOpenAI() {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.");
    }
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

let chromaClient;
export function getChroma() {
  if (!chromaClient) {
    chromaClient = new ChromaClient({
      host: process.env.CHROMA_HOST || "localhost",
      port: process.env.CHROMA_PORT ? Number(process.env.CHROMA_PORT) : 8000,
      ssl: process.env.CHROMA_SSL === "true",
    });
  }
  return chromaClient;
}

// We always supply our own OpenAI-computed embeddings, so the collection
// needs no server-side embedding function (avoids requiring the default
// embedding model to be installed on the Chroma server).
export async function getCollection() {
  const client = getChroma();
  return client.getOrCreateCollection({
    name: COLLECTION_NAME,
    embeddingFunction: null,
  });
}

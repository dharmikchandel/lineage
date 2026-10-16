// Claim embeddings for the vector index (Q1). One model for seed AND runtime:
// vectors from different models are not comparable, so there is no fallback provider.

import { config } from "@/lib/config";
import { cacheGet, cachePut, hashKey } from "./cache";
import { type RunBudget, withBackoff } from "./budget";

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/** gemini-embedding-001 returns unnormalised vectors below 3072 dims; cosine needs unit length. */
export function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

export function embeddingCacheKey(text: string): string {
  return hashKey([config.embedding.provider, config.embedding.model, config.embedding.dim, text]);
}

export async function embed(text: string, budget: RunBudget): Promise<{ vector: number[]; cached: boolean }> {
  const { provider, model, apiKey, dim } = config.embedding;
  if (provider !== "gemini") throw new EmbeddingError(`Unsupported EMBEDDING_PROVIDER "${provider}" (expected gemini).`);
  if (!model) throw new EmbeddingError("EMBEDDING_MODEL is not set.");

  const key = embeddingCacheKey(text);
  const hit = await cacheGet<number[]>("embed", key);
  if (hit && hit.length === dim) return { vector: hit, cached: true };

  if (!apiKey) throw new EmbeddingError("No embedding API key (EMBEDDING_API_KEY or GEMINI_API_KEY) is set (Gate 1).");
  await budget.beforeEmbedCall();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent`;
  const res = await withBackoff(() =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType: "SEMANTIC_SIMILARITY",
        outputDimensionality: dim,
      }),
    }),
  );
  if (!res.ok) throw new EmbeddingError(`Embedding HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { embedding?: { values?: number[] }; embeddings?: { values?: number[] }[] };
  const values = body.embedding?.values ?? body.embeddings?.[0]?.values;
  if (!values || values.length !== dim) {
    throw new EmbeddingError(`Expected a ${dim}-dimension vector, got ${values?.length ?? "none"}.`);
  }
  await budget.afterEmbedCall();
  const vector = l2normalize(values);
  await cachePut("embed", key, vector);
  return { vector, cached: false };
}

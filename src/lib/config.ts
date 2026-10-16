// Reads configuration from the environment (.env). Never logs values: callers
// that need to report on config use `describeConfig()`, which only prints names.
import "dotenv/config";

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function num(name: string, fallback: number): number {
  const raw = str(name);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export const config = {
  falkor: {
    host: str("FALKORDB_HOST", "localhost"),
    port: num("FALKORDB_PORT", 6380),
    username: str("FALKORDB_USERNAME"),
    password: str("FALKORDB_PASSWORD"),
    graph: str("FALKORDB_GRAPH_NAME", "lineage"),
  },
  llm: {
    provider: str("LLM_PROVIDER"),
    model: str("LLM_MODEL"),
    // Gemini 3.x models always "think"; thought tokens count toward MAX_TOKENS_PER_CALL.
    thinkingLevel: str("LLM_THINKING_LEVEL", "minimal"),
    geminiKey: str("GEMINI_API_KEY"),
    fallbackProvider: str("LLM_FALLBACK_PROVIDER"),
    fallbackModel: str("LLM_FALLBACK_MODEL"),
    groqKey: str("GROQ_API_KEY"),
  },
  embedding: {
    provider: str("EMBEDDING_PROVIDER"),
    model: str("EMBEDDING_MODEL"),
    // Falls back to the Gemini key: one key covers both on the free tier.
    apiKey: str("EMBEDDING_API_KEY") || str("GEMINI_API_KEY"),
    dim: num("EMBEDDING_DIM", 768),
  },
  budget: {
    maxCallsPerRun: num("MAX_LLM_CALLS_PER_RUN", 3),
    maxCallsPerDay: num("MAX_LLM_CALLS_PER_DAY", 200),
    maxTokensPerCall: num("MAX_TOKENS_PER_CALL", 1024),
    maxRequestsPerMinute: num("MAX_REQUESTS_PER_MINUTE", 8),
  },
  propagation: {
    decay: num("PROPAGATION_DECAY", 0.9),
    threshold: num("PROPAGATION_THRESHOLD", 0.4),
    maxDepth: Math.trunc(num("PROPAGATION_MAX_DEPTH", 6)),
  },
  mode: (str("LINEAGE_MODE", "local") === "recorded" ? "recorded" : "local") as "local" | "recorded",
};

/** Variables required per gate. Used by preflight; reports names only. */
export function requiredVariables(): { name: string; gate: string; present: boolean }[] {
  const has = (n: string) => str(n) !== "";
  const rows = [
    { name: "FALKORDB_HOST", gate: "0 (graph)" },
    { name: "FALKORDB_PORT", gate: "0 (graph)" },
    { name: "FALKORDB_GRAPH_NAME", gate: "0 (graph)" },
    { name: "EMBEDDING_PROVIDER", gate: "1 (embeddings)" },
    { name: "EMBEDDING_MODEL", gate: "1 (embeddings)" },
    { name: "EMBEDDING_DIM", gate: "1 (embeddings)" },
    { name: "LLM_PROVIDER", gate: "2 (agents)" },
    { name: "LLM_MODEL", gate: "2 (agents)" },
    { name: "GEMINI_API_KEY", gate: "1+2 (embeddings, agents)" },
    { name: "MAX_LLM_CALLS_PER_RUN", gate: "2 (agents)" },
    { name: "MAX_LLM_CALLS_PER_DAY", gate: "2 (agents)" },
    { name: "MAX_TOKENS_PER_CALL", gate: "2 (agents)" },
  ];
  if (has("LLM_FALLBACK_PROVIDER")) rows.push({ name: "GROQ_API_KEY", gate: "2 (fallback)" });
  return rows.map((r) => ({ ...r, present: has(r.name) }));
}

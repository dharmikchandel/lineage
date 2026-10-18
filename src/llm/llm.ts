// Structured-JSON LLM calls. Every call:
//   - is checked against the run and daily budgets first,
//   - is cached by a hash of (provider, model, prompt, schema),
//   - asks for JSON matching a schema and validates the reply with zod,
//   - retries once on invalid JSON, then fails with a clear error,
//   - reports which provider answered and whether it came from cache (shown in the trace).
// There is no silent substitution: a fallback provider is used only if LLM_FALLBACK_PROVIDER is set.

import { z } from "zod";
import { config } from "@/lib/config";
import { cacheGet, cachePut, hashKey, offline } from "./cache";
import { type RunBudget, BudgetExceededError, withBackoff } from "./budget";

export interface LlmResult<T> {
  data: T;
  provider: string;
  model: string;
  cached: boolean;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

interface RawReply {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

async function callGemini(model: string, system: string, user: string, jsonSchema: object, maxTokens: number): Promise<RawReply> {
  if (!config.llm.geminiKey) throw new LlmError("GEMINI_API_KEY is not set (Gate 2).");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await withBackoff(() =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.llm.geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: maxTokens,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
          thinkingConfig: { thinkingLevel: config.llm.thinkingLevel },
        },
      }),
    }),
  );
  if (!res.ok) {
    // Never echo request headers (they hold the key); the body is Google's error message.
    throw new LlmError(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new LlmError(`Gemini returned no text (finishReason: ${body.candidates?.[0]?.finishReason ?? "unknown"}).`);
  return {
    text,
    tokensIn: body.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: body.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

async function callGroq(model: string, system: string, user: string, jsonSchema: object, maxTokens: number): Promise<RawReply> {
  if (!config.llm.groqKey) throw new LlmError("GROQ_API_KEY is not set but LLM_FALLBACK_PROVIDER=groq.");
  const res = await withBackoff(() =>
    fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.llm.groqKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${system}\n\nReply with JSON matching this schema:\n${JSON.stringify(jsonSchema)}` },
          { role: "user", content: user },
        ],
      }),
    }),
  );
  if (!res.ok) throw new LlmError(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    tokensIn: body.usage?.prompt_tokens ?? 0,
    tokensOut: body.usage?.completion_tokens ?? 0,
  };
}

function providers(): { name: string; model: string; call: typeof callGemini }[] {
  const list: { name: string; model: string; call: typeof callGemini }[] = [];
  if (config.llm.provider !== "gemini") throw new LlmError(`Unsupported LLM_PROVIDER "${config.llm.provider}" (expected gemini).`);
  if (!config.llm.model) throw new LlmError("LLM_MODEL is not set.");
  list.push({ name: "gemini", model: config.llm.model, call: callGemini });
  if (config.llm.fallbackProvider === "groq") {
    if (!config.llm.fallbackModel) throw new LlmError("LLM_FALLBACK_MODEL is not set.");
    list.push({ name: "groq", model: config.llm.fallbackModel, call: callGroq });
  }
  return list;
}

/**
 * Ask the LLM for JSON that matches `schema`. `task` names the agent for error messages.
 */
export async function generateJson<S extends z.ZodType>(opts: {
  task: string;
  system: string;
  user: string;
  schema: S;
  budget: RunBudget;
  /** Lower the per-call token cap (never raise it above MAX_TOKENS_PER_CALL). */
  maxTokens?: number;
}): Promise<LlmResult<z.infer<S>>> {
  const jsonSchema = z.toJSONSchema(opts.schema, { target: "draft-7" });
  const maxTokens = Math.min(opts.maxTokens ?? Infinity, config.budget.maxTokensPerCall);
  let lastError: unknown = null;

  for (const p of providers()) {
    const key = hashKey([p.name, p.model, opts.system, opts.user, jsonSchema]);
    const hit = await cacheGet<unknown>("llm", key);
    if (hit !== null) {
      const parsed = opts.schema.safeParse(hit);
      if (parsed.success) return { data: parsed.data, provider: p.name, model: p.model, cached: true };
    }
    if (offline()) {
      throw new LlmError(`${opts.task}: this input has no recorded reply, and recorded mode never calls the model. Run Lineage locally to analyse new text.`);
    }

    try {
      // One call, plus one retry if the JSON does not validate.
      for (let attempt = 1; attempt <= 2; attempt++) {
        await opts.budget.beforeLlmCall();
        const reply = await p.call(p.model, opts.system, opts.user, jsonSchema, maxTokens);
        await opts.budget.afterLlmCall(reply.tokensIn, reply.tokensOut);
        let json: unknown;
        try {
          json = JSON.parse(reply.text);
        } catch {
          lastError = new LlmError(`${opts.task}: ${p.name} returned invalid JSON.`);
          continue;
        }
        const parsed = opts.schema.safeParse(json);
        if (parsed.success) {
          await cachePut("llm", key, parsed.data);
          return { data: parsed.data, provider: p.name, model: p.model, cached: false };
        }
        lastError = new LlmError(`${opts.task}: ${p.name} reply did not match the schema: ${parsed.error.message.slice(0, 300)}`);
      }
      throw lastError;
    } catch (err) {
      // Budget limits are final: never route around them via the fallback.
      if (err instanceof BudgetExceededError) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new LlmError(`${opts.task}: LLM call failed.`);
}

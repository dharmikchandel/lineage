// Free-tier discipline: per-run and per-day call caps, a requests-per-minute
// limiter, and exponential backoff on HTTP 429. The daily counter is persisted in
// .cache/usage.json and resets at midnight Pacific (when Gemini quotas reset).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";

const USAGE_FILE = path.join(process.cwd(), ".cache", "usage.json");

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

interface Usage {
  day: string; // YYYY-MM-DD in America/Los_Angeles
  llmCalls: number;
  embedCalls: number;
  tokensIn: number;
  tokensOut: number;
}

export function pacificDay(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
}

async function loadUsage(): Promise<Usage> {
  const today = pacificDay();
  try {
    const u = JSON.parse(await readFile(USAGE_FILE, "utf8")) as Usage;
    if (u.day === today) return u;
  } catch {
    /* first run today */
  }
  return { day: today, llmCalls: 0, embedCalls: 0, tokensIn: 0, tokensOut: 0 };
}

async function saveUsage(u: Usage) {
  await mkdir(path.dirname(USAGE_FILE), { recursive: true });
  await writeFile(USAGE_FILE, JSON.stringify(u, null, 2));
}

/** Tracks one analysis run. Create one per pasted claim. */
export class RunBudget {
  llmCalls = 0;
  embedCalls = 0;

  async beforeLlmCall(): Promise<void> {
    if (this.llmCalls >= config.budget.maxCallsPerRun) {
      throw new BudgetExceededError(`Per-run LLM limit reached (MAX_LLM_CALLS_PER_RUN=${config.budget.maxCallsPerRun}).`);
    }
    const u = await loadUsage();
    if (u.llmCalls >= config.budget.maxCallsPerDay) {
      throw new BudgetExceededError(`Daily LLM limit reached (MAX_LLM_CALLS_PER_DAY=${config.budget.maxCallsPerDay}); resets at midnight Pacific.`);
    }
    await throttle();
  }

  async afterLlmCall(tokensIn: number, tokensOut: number): Promise<void> {
    this.llmCalls++;
    const u = await loadUsage();
    u.llmCalls++;
    u.tokensIn += tokensIn;
    u.tokensOut += tokensOut;
    await saveUsage(u);
  }

  async beforeEmbedCall(): Promise<void> {
    await throttle();
  }

  async afterEmbedCall(): Promise<void> {
    this.embedCalls++;
    const u = await loadUsage();
    u.embedCalls++;
    await saveUsage(u);
  }
}

export async function todaysUsage(): Promise<Usage> {
  return loadUsage();
}

// Simple spacing limiter: at most MAX_REQUESTS_PER_MINUTE requests, one at a time.
let lastRequestAt = 0;
let chain: Promise<void> = Promise.resolve();

function throttle(): Promise<void> {
  const gap = 60_000 / Math.max(1, config.budget.maxRequestsPerMinute);
  chain = chain.then(async () => {
    const wait = lastRequestAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
  });
  return chain;
}

/** Retry a request on HTTP 429 / 503 with exponential backoff (2s, 4s, 8s). */
export async function withBackoff(fn: () => Promise<Response>, attempts = 4): Promise<Response> {
  let delay = 2000;
  for (let i = 0; ; i++) {
    const res = await fn();
    if ((res.status !== 429 && res.status !== 503) || i >= attempts - 1) return res;
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
}

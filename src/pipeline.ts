// One analysis = four agents in order. They share nothing in memory: each reads
// the previous agent's findings back from FalkorDB (see src/agents/trace.ts).
// Used by both the CLI (scripts/analyze.ts) and the web API (src/app/api/analyze).

import { randomUUID } from "node:crypto";
import { graphCounts } from "@/graph/queries";
import { RunBudget } from "@/llm/budget";
import { runExtractor } from "@/agents/extractor";
import { runLinker } from "@/agents/linker";
import { runSkeptic } from "@/agents/skeptic";
import { type Answer, runWriter } from "@/agents/writer";

export class EmptyGraphError extends Error {
  constructor() {
    super("The graph is empty. Run `pnpm schema && pnpm seed` first.");
    this.name = "EmptyGraphError";
  }
}

export interface AnalysisResult {
  analysisId: string;
  answers: Answer[];
  llmCalls: number;
  embedCalls: number;
}

export function newAnalysisId(): string {
  return randomUUID();
}

export async function runAnalysis(
  text: string,
  opts: { analysisId?: string; synthetic: boolean; sightingDate?: string },
): Promise<AnalysisResult> {
  if ((await graphCounts()).claims === 0) throw new EmptyGraphError();
  const analysisId = opts.analysisId ?? newAnalysisId();
  const budget = new RunBudget();
  const sightingDate = opts.sightingDate ?? new Date().toLocaleDateString("en-CA"); // local YYYY-MM-DD

  await runExtractor(analysisId, text, budget);
  await runLinker(analysisId, budget, { synthetic: opts.synthetic, sightingDate });
  await runSkeptic(analysisId);
  const answers = await runWriter(analysisId, budget);
  return { analysisId, answers, llmCalls: budget.llmCalls, embedCalls: budget.embedCalls };
}

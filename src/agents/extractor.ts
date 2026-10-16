// Agent 1: Extractor (LLM, 1 call).
// Splits the pasted text into atomic claims (one checkable sentence each) and pulls
// out the numbers, dates and named sources. Writes one Finding per atomic claim.
// It creates no Claim nodes: whether a claim is new is the Linker's decision.

import { z } from "zod";
import { generateJson } from "@/llm/llm";
import type { RunBudget } from "@/llm/budget";
import { type AgentContext, runAgent } from "./trace";

export const AtomicClaimSchema = z.object({
  text: z.string().min(5).describe("One checkable sentence, paraphrased neutrally in your own words."),
  numbers: z.array(z.string()).describe("Every number or quantity, as written (e.g. '15 days')."),
  dates: z.array(z.string()).describe("Every date or time period, as written (e.g. 'November 2026')."),
  attributed_to: z.string().nullable().describe("Who the claim says said or confirmed it (e.g. 'NASA'), or null."),
});
export type AtomicClaim = z.infer<typeof AtomicClaimSchema>;

const ExtractorOutput = z.object({
  claims: z.array(AtomicClaimSchema).max(5),
});

const SYSTEM = `You split text into atomic factual claims for a claim-lineage tracker.
Rules:
- One claim per checkable assertion. Ignore opinions, greetings and calls to action.
- Keep a claim's cited source or evidence in the SAME claim ("according to X", "X confirms", "a report sent to Y says"). Who said it, and on what authority, is part of the claim, never a separate claim.
- Paraphrase each claim as one neutral sentence. Keep every number, date and attribution exactly as stated.
- Never add facts that are not in the text. Never judge truth.
- At most 5 claims. If the text contains no checkable claim, return an empty list.`;

export async function runExtractor(analysisId: string, input: string, budget: RunBudget): Promise<AtomicClaim[]> {
  return runAgent({ analysisId, agent: "extractor", seq: 1, method: "llm" }, async (ctx: AgentContext) => {
    // The raw input is kept on the trace only (never as a Claim), so a run can be replayed.
    await ctx.find("input", "Text received for analysis", { text: input });

    const res = await generateJson({
      task: "Extractor",
      system: SYSTEM,
      user: `Text:\n"""\n${input}\n"""`,
      schema: ExtractorOutput,
      budget,
    });
    ctx.setProvider(res);

    for (const c of res.data.claims) {
      await ctx.find("atomic_claim", c.text, c);
    }
    if (res.data.claims.length === 0) {
      await ctx.find("no_claims", "No checkable claim found in the input.", {});
    }
    return res.data.claims;
  });
}

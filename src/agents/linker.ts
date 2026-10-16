// Agent 2: Linker (1 embedding per atomic claim + at most 1 batched LLM call).
//
// For each atomic claim the Extractor wrote to the graph:
//   1. embed it and run Q1 (vector nearest neighbours in FalkorDB),
//   2. ask the LLM, in ONE batched call for all claims, to judge each candidate as
//      same / mutation / related / unrelated (with mutation types and before/after text),
//   3. write back:
//        same      -> new Sighting on the existing Claim (no new Claim node)
//        mutation  -> new Claim + MUTATED_FROM edge(s) to the parent(s)
//        otherwise -> new Claim with no lineage (the graph will know it next time)

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Candidate, q1Candidates } from "@/graph/queries";
import { CycleError, addSighting, linkMutation, upsertClaim } from "@/graph/writes";
import { LINK_JUDGMENTS, MUTATION_RELIABILITY, MUTATION_TYPES, type MutationType } from "@/domain/types";
import { generateJson } from "@/llm/llm";
import { embed } from "@/llm/embed";
import type { RunBudget } from "@/llm/budget";
import type { AtomicClaim } from "./extractor";
import { readFindings, runAgent } from "./trace";

/** Candidates less similar than this are not shown to the LLM at all (saves quota, avoids forced matches). */
export const MIN_CANDIDATE_SIMILARITY = 0.6;
const TOP_K = 5;

const Judgment = z.object({
  claim_index: z.number().int(),
  candidate_id: z.string(),
  judgment: z.enum(LINK_JUDGMENTS),
  mutation_types: z.array(z.enum(MUTATION_TYPES)).describe("Only for 'mutation': how the NEW claim differs from the candidate."),
  before_text: z.string().describe("The candidate's wording of the changed part (empty unless 'mutation')."),
  after_text: z.string().describe("The new claim's wording of the changed part (empty unless 'mutation')."),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(300),
});
const LinkerOutput = z.object({ judgments: z.array(Judgment) });
type JudgmentT = z.infer<typeof Judgment>;

const SYSTEM = `You compare a NEW claim with CANDIDATE claims already in a claim-lineage graph.
For every (new claim, candidate) pair, output one judgment:
- "same": the same assertion, only reworded. Numbers, dates and attribution all match.
- "mutation": the same story, but the new claim changes it. List every change type:
    number_change (a quantity differs), date_shift (a date or period differs),
    attribution_change (who said/confirmed it differs), exaggeration (stronger or more dramatic),
    context_stripped (qualifying context removed).
  Give before_text (the candidate's wording of the changed part) and after_text (the new wording).
- "related": same topic, but a different assertion.
- "unrelated": different topic.
Judge only from the text given. Never use outside knowledge about whether a claim is true.`;

export interface LinkOutcome {
  claimId: string;
  text: string;
  status: "same" | "mutation" | "new";
  parents: { id: string; types: MutationType[]; confidence: number }[];
}

export async function runLinker(
  analysisId: string,
  budget: RunBudget,
  opts: { synthetic: boolean; sightingDate: string; sourceUrl?: string | null },
): Promise<LinkOutcome[]> {
  return runAgent({ analysisId, agent: "linker", seq: 2, method: "llm" }, async (ctx) => {
    // Coordination through the graph: read what the Extractor wrote.
    const atomic = (await readFindings<AtomicClaim>(analysisId, "extractor", "atomic_claim")).map((f) => f.data);

    // 1. Embed each claim and retrieve candidates with Q1.
    const embedded: { claim: AtomicClaim; vector: number[]; candidates: Candidate[] }[] = [];
    for (const claim of atomic) {
      const { vector, cached } = await embed(claim.text, budget);
      const candidates = (await q1Candidates(vector, TOP_K)).filter((c) => c.similarity >= MIN_CANDIDATE_SIMILARITY);
      embedded.push({ claim, vector, candidates });
      await ctx.find(
        "candidates",
        candidates.length
          ? `Q1 found ${candidates.length} candidate(s) for "${claim.text}" (best similarity ${candidates[0].similarity.toFixed(2)})`
          : `Q1 found no candidate above ${MIN_CANDIDATE_SIMILARITY} similarity for "${claim.text}"`,
        { claim: claim.text, embeddingCached: cached, candidates: candidates.map((c) => ({ id: c.id, similarity: c.similarity })) },
        candidates.map((c) => c.id),
      );
    }

    // 2. One batched LLM judgment over every pair (skipped entirely if nothing to compare).
    let judgments: JudgmentT[] = [];
    if (embedded.some((e) => e.candidates.length > 0)) {
      const user = embedded
        .map(
          (e, i) =>
            `NEW CLAIM ${i}: ${e.claim.text}\n` +
            (e.candidates.length
              ? e.candidates.map((c) => `  CANDIDATE ${c.id} (first seen ${c.firstSeen ?? "unknown"}): ${c.text}`).join("\n")
              : "  (no candidates)"),
        )
        .join("\n\n");
      const res = await generateJson({ task: "Linker", system: SYSTEM, user, schema: LinkerOutput, budget });
      ctx.setProvider(res);
      judgments = res.data.judgments;
    }

    // 3. Write back.
    const outcomes: LinkOutcome[] = [];
    for (const [i, e] of embedded.entries()) {
      const valid = new Set(e.candidates.map((c) => c.id));
      const mine = judgments.filter((j) => j.claim_index === i && valid.has(j.candidate_id));
      const same = mine.filter((j) => j.judgment === "same").sort((a, b) => b.confidence - a.confidence)[0];
      const sightingId = `s-${randomUUID()}`;
      const snippet = e.claim.text;

      if (same) {
        await addSighting({ id: sightingId, claimId: same.candidate_id, publisher: null, url: opts.sourceUrl ?? null, date: opts.sightingDate, snippet, synthetic: opts.synthetic });
        await ctx.find("link_same", `Same claim as ${same.candidate_id}; added a sighting`, same, [same.candidate_id]);
        outcomes.push({ claimId: same.candidate_id, text: e.claim.text, status: "same", parents: [] });
        continue;
      }

      const claimId = `c-${randomUUID()}`;
      await upsertClaim({ id: claimId, text: e.claim.text, firstSeen: opts.sightingDate, attributedTo: e.claim.attributed_to, synthetic: opts.synthetic, embedding: e.vector });
      await addSighting({ id: sightingId, claimId, publisher: null, url: opts.sourceUrl ?? null, date: opts.sightingDate, snippet, synthetic: opts.synthetic });

      // Up to two parents: a claim may merge two earlier versions (the lineage is a DAG).
      const mutations = mine
        .filter((j) => j.judgment === "mutation" && j.mutation_types.length > 0)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 2);
      const parents: LinkOutcome["parents"] = [];
      for (const m of mutations) {
        // Cap confidence by how reliably the least reliable mutation type can be detected.
        const cap = Math.min(...m.mutation_types.map((t) => MUTATION_RELIABILITY[t]));
        const confidence = Math.min(m.confidence, cap);
        try {
          const { directionCertain } = await linkMutation({
            childId: claimId,
            parentId: m.candidate_id,
            types: m.mutation_types,
            beforeText: m.before_text,
            afterText: m.after_text,
            confidence,
            assertedBy: "linker",
          });
          parents.push({ id: m.candidate_id, types: m.mutation_types, confidence });
          await ctx.find(
            "link_mutation",
            `Mutated from ${m.candidate_id}: ${m.mutation_types.join(", ")} ("${m.before_text}" -> "${m.after_text}")`,
            { ...m, confidence, directionCertain },
            [claimId, m.candidate_id],
          );
        } catch (err) {
          if (!(err instanceof CycleError)) throw err;
          await ctx.find("link_refused", `Refused edge to ${m.candidate_id}: ${err.message}`, m, [claimId, m.candidate_id]);
        }
      }
      if (parents.length === 0) {
        await ctx.find("link_none", `No lineage found; stored as a new claim`, { claim: e.claim.text }, [claimId]);
      }
      outcomes.push({ claimId, text: e.claim.text, status: parents.length ? "mutation" : "new", parents });
    }
    return outcomes;
  });
}

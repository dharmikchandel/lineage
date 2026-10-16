// Agent 4: Writer (at most 1 batched LLM call, 0 if every claim is unknown).
//
// Builds the final answer for each claim from graph findings ONLY:
//   - every fact (verdict, basis, confidence, sources, chain, publishers) is assembled
//     by code from the Skeptic's assessment and Q2/Q5/Q6,
//   - the LLM only phrases a short plain-English summary from that fact sheet,
//   - the summary is checked: it may not contain a URL or a number that is not in the
//     fact sheet. If it does, it is discarded and a template sentence is used instead
//     (recorded as a finding, never silent).

import { z } from "zod";
import { q2Origins, q5FamilyOf, q6PublisherSpread } from "@/graph/queries";
import { read } from "@/lib/db";
import { generateJson } from "@/llm/llm";
import type { RunBudget } from "@/llm/budget";
import type { ClaimAssessment } from "./skeptic";
import { readFindings, runAgent } from "./trace";

export interface Answer extends ClaimAssessment {
  synthetic: boolean;
  chain: { id: string; text: string; firstSeen: string | null }[];
  mutationCount: number;
  origins: { contested: boolean; list: { name: string; confidence: number; evidenceUrl: string; note: string | null }[] };
  family: { variants: number; firstSeen: string | null; lastSeen: string | null } | null;
  publisherCount: number;
  whatTheGraphDid: string;
  headline: string;
  summary: string;
  writtenBy: "llm" | "template";
}

const WriterOutput = z.object({
  answers: z.array(
    z.object({
      claim_index: z.number().int(),
      headline: z.string().max(120).describe("At most 12 words. States the finding, not a bare true/false."),
      summary: z.string().max(600).describe("2-3 plain sentences for a non-technical reader."),
    }),
  ),
});

const SYSTEM = `You write the final answer of a claim-lineage tracker for a non-technical reader.
You get a FACT SHEET per claim. Use ONLY facts in the sheet.
- Never add a source, date, number, name or verdict that is not in the sheet.
- Never write a URL.
- Never say simply "true" or "false". Say what the evidence trail shows and how confident it is.
- If the result is "unknown", say there is no evidence in the graph.
- If the result is "correction", say this version credits the established true source, so it corrects an older misattributed version rather than spreading it.
- If the result is "needs_own_check", say related debunks exist but their reason does not apply to this version, so it needs its own fact-check.
- Mention a contested origin if the sheet says so.
- Write confidence exactly as given (for example 0.81), never as a percentage.`;

const year = (d: string | null | undefined) => (d ? d.slice(0, 4) : null);

function whatTheGraphDid(a: Omit<Answer, "whatTheGraphDid" | "headline" | "summary" | "writtenBy">): string {
  const parts: string[] = [];
  if (a.chain.length > 1) {
    parts.push(`Followed ${a.chain.length - 1} MUTATED_FROM hop(s) back to a ${year(a.chain[a.chain.length - 1].firstSeen) ?? "undated"} version`);
  }
  if (a.family) {
    const span = a.family.firstSeen && a.family.lastSeen ? Number(year(a.family.lastSeen)) - Number(year(a.family.firstSeen)) : null;
    parts.push(`found a story family of ${a.family.variants} variants${span !== null ? ` spanning ${span} years` : ""}, posted by ${a.publisherCount} publisher(s)`);
  }
  if (a.kind === "inherited") {
    parts.push(
      a.hops === 0
        ? `found ${a.supporting.length} fact-check(s) on this exact claim`
        : `carried a "${a.basis}" debunk forward ${a.hops} hop(s) because its reason still applies`,
    );
  } else if (a.kind === "correction") {
    parts.push("recognised a re-attribution to the established true source as a correction");
  } else if (a.kind === "needs_own_check") {
    parts.push(`found ${a.notCarried.length} fact-check(s) up the chain whose reason does not carry over`);
  } else {
    parts.push("found no matching claim, so it says Unknown instead of guessing");
  }
  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function templateText(a: Omit<Answer, "headline" | "summary" | "writtenBy">): { headline: string; summary: string } {
  switch (a.kind) {
    case "unknown":
      return { headline: "No evidence in the graph", summary: "No match in the graph. Unknown." };
    case "correction":
      return { headline: "Looks like a correction, not a mutation", summary: a.explanation };
    case "needs_own_check":
      return { headline: "Related debunks exist, but do not apply", summary: `${a.explanation} ${a.notCarried[0]?.reason ?? ""}`.trim() };
    case "inherited": {
      const by = [...new Set(a.supporting.map((s) => s.publisher))].join(", ");
      return {
        headline: `A version of a debunked claim (${a.basis})`,
        summary: `${a.explanation} Supported by: ${by}. Confidence ${a.confidence.toFixed(2)}.${a.origins.contested ? " The origin is contested." : ""}`,
      };
    }
  }
}

/** The fact sheet sent to the LLM: only what the graph says, no ids or URLs. */
function factSheet(a: Omit<Answer, "headline" | "summary" | "writtenBy">) {
  return {
    claim: a.text,
    result: a.kind,
    what_the_rules_concluded: a.explanation,
    verdict: a.verdict,
    reason_for_verdict: a.basis,
    confidence: a.kind === "inherited" ? Number(a.confidence.toFixed(2)) : null,
    mutation_hops_from_fact_check: a.kind === "inherited" ? a.hops : null,
    fact_checkers: [...new Set(a.supporting.map((s) => s.publisher))],
    oldest_known_version: a.chain.length > 1 ? { text: a.chain[a.chain.length - 1].text, first_seen: a.chain[a.chain.length - 1].firstSeen } : null,
    versions_in_story: a.family?.variants ?? 1,
    first_seen: a.family?.firstSeen ?? null,
    publishers: a.publisherCount,
    origin_contested: a.origins.contested,
    origins: a.origins.list.map((o) => o.name),
    debunks_not_carried_over: a.notCarried.map((n) => n.reason),
    cautions: a.cautions,
  };
}

/** Numbers and URLs in the summary must come from the fact sheet. */
export function groundingProblem(text: string, sheet: unknown): string | null {
  if (/https?:\/\/|www\./i.test(text)) return "contains a URL";
  const allowed = JSON.stringify(sheet);
  const allowedNumbers = new Set(allowed.match(/\d+(?:\.\d+)?/g) ?? []);
  for (const n of text.match(/\d+(?:\.\d+)?/g) ?? []) {
    if (!allowedNumbers.has(n)) return `mentions the number ${n}, which is not in the fact sheet`;
  }
  return null;
}

export async function runWriter(analysisId: string, budget: RunBudget): Promise<Answer[]> {
  return runAgent({ analysisId, agent: "writer", seq: 4, method: "llm" }, async (ctx) => {
    const assessments = (await readFindings<ClaimAssessment>(analysisId, "skeptic", "assessment")).map((f) => f.data);

    // 1. Assemble the facts from the graph.
    const drafts: Omit<Answer, "headline" | "summary" | "writtenBy">[] = [];
    for (const a of assessments) {
      const [meta] = await read<{ synthetic: boolean }>(`MATCH (c:Claim {id: $id}) RETURN c.synthetic AS synthetic`, { id: a.claimId });
      const q2 = await q2Origins(a.claimId);
      // Longest upward chain = the full lineage back to the oldest root.
      const chain = q2.rows.map((r) => r.chain).sort((x, y) => y.length - x.length)[0] ?? [];
      const longest = q2.rows.find((r) => r.chain === chain);
      const fam = await q5FamilyOf(a.claimId);
      const spread = fam ? await q6PublisherSpread(fam.claimIds) : [];
      const originList = [...new Map(q2.rows.flatMap((r) => r.origins).map((o) => [o.name, o])).values()].map((o) => ({
        name: o.name, confidence: o.confidence, evidenceUrl: o.evidenceUrl, note: o.note,
      }));
      const base = {
        ...a,
        synthetic: Boolean(meta?.synthetic),
        chain,
        mutationCount: longest?.hops.length ?? 0,
        origins: { contested: q2.contested, list: originList },
        family: fam ? { variants: fam.variants, firstSeen: fam.firstSeen, lastSeen: fam.lastSeen } : null,
        publisherCount: spread.length,
      };
      drafts.push({ ...base, whatTheGraphDid: whatTheGraphDid(base) });
    }

    // 2. One batched LLM call for the prose, skipped when there is nothing to explain.
    const needsLlm = drafts.map((d, i) => ({ d, i })).filter(({ d }) => d.kind !== "unknown");
    const prose = new Map<number, { headline: string; summary: string }>();
    if (needsLlm.length > 0) {
      const sheets = needsLlm.map(({ d, i }) => ({ claim_index: i, ...factSheet(d) }));
      const res = await generateJson({
        task: "Writer",
        system: SYSTEM,
        user: `FACT SHEETS:\n${JSON.stringify(sheets, null, 1)}`,
        schema: WriterOutput,
        budget,
      });
      ctx.setProvider(res);
      for (const ans of res.data.answers) {
        const sheet = sheets.find((s) => s.claim_index === ans.claim_index);
        if (!sheet) continue;
        const problem = groundingProblem(`${ans.headline} ${ans.summary}`, sheet);
        if (problem) {
          await ctx.find("grounding_rejected", `LLM summary discarded: it ${problem}. Using the template instead.`, ans);
          continue;
        }
        prose.set(ans.claim_index, { headline: ans.headline, summary: ans.summary });
      }
    }

    // 3. Final answers.
    const answers: Answer[] = drafts.map((d, i) => {
      const p = prose.get(i);
      return p ? { ...d, ...p, writtenBy: "llm" } : { ...d, ...templateText(d), writtenBy: "template" };
    });
    for (const a of answers) {
      await ctx.find("answer", a.headline, a, [a.claimId]);
    }
    return answers;
  });
}

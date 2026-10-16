// The Skeptic's rules (pure, no I/O, no LLM).
//
// Input: the derived verdict from Q4 plus what Q2 says about origins.
// Output: an assessment that can only keep or LOWER confidence, never raise it,
// and a list of plain-English cautions explaining why.

import type { DerivedVerdict, PathOutcome } from "./propagation";
import type { DebunkBasis, FactCheckVerdict } from "./types";

export interface SkepticSettings {
  /** Multiplied in when the verdict rests on a single fact-checker. */
  singleSourcePenalty: number;
  /** Multiplied in when any hop on the winning path has an uncertain direction. */
  uncertainDirectionPenalty: number;
  /** Edges below this confidence are called out as weak links. */
  weakLinkBelow: number;
}

export const DEFAULT_SKEPTIC: SkepticSettings = {
  singleSourcePenalty: 0.9,
  uncertainDirectionPenalty: 0.9,
  weakLinkBelow: 0.6,
};

export interface OriginSummary {
  contested: boolean;
  names: string[];
}

export interface FactCheckRef {
  publisher: string;
  url: string;
  date: string | null;
  verdict: FactCheckVerdict;
  basis: DebunkBasis | null;
  hops: number;
}

export interface Assessment {
  kind: "inherited" | "correction" | "needs_own_check" | "unknown";
  verdict: FactCheckVerdict | null;
  basis: DebunkBasis | null;
  /** Confidence after the Skeptic's adjustments (0 when there is no verdict). */
  confidence: number;
  /** Confidence straight from Q4 before adjustments, for transparency. */
  rawConfidence: number;
  hops: number;
  /** Every fact-check whose debunk still applies, nearest first. */
  supporting: FactCheckRef[];
  /** For a correction: the debunk of the misattributed version this one corrects. */
  corrects?: FactCheckRef;
  /** Fact-checks found up the chain whose reason no longer applies, and why. */
  notCarried: { factCheck: FactCheckRef; reason: string; delta?: { before: string; after: string } }[];
  cautions: string[];
  explanation: string;
}

function ref(o: PathOutcome): FactCheckRef {
  const f = o.path.factCheck;
  return { publisher: f.publisher, url: f.url, date: f.date, verdict: f.verdict, basis: f.basis, hops: o.path.hops.length };
}

export function assess(v: DerivedVerdict, origin: OriginSummary, s: SkepticSettings = DEFAULT_SKEPTIC): Assessment {
  const cautions: string[] = [];
  if (origin.contested) {
    cautions.push(`Origin is contested: sources disagree between ${origin.names.join(" and ")}.`);
  }

  const notCarried = v.all
    .filter((o) => o.status === "broken" || o.status === "context_only")
    .map((o) => ({
      factCheck: ref(o),
      reason: o.explanation,
      delta: o.status === "broken" ? o.delta : undefined,
    }));

  if (v.kind === "unknown") {
    return {
      kind: "unknown", verdict: null, basis: null, confidence: 0, rawConfidence: 0, hops: 0,
      supporting: [], notCarried: [], cautions,
      explanation: "No match in the graph. Unknown.",
    };
  }

  if (v.kind === "correction") {
    return {
      kind: "correction", verdict: null, basis: null, confidence: 0, rawConfidence: 0, hops: v.outcome.path.hops.length,
      supporting: [], corrects: ref(v.outcome), notCarried, cautions,
      explanation: v.outcome.explanation,
    };
  }

  if (v.kind === "needs_own_check") {
    return {
      kind: "needs_own_check", verdict: null, basis: null, confidence: 0, rawConfidence: 0, hops: 0,
      supporting: [], notCarried, cautions,
      explanation: "Related fact-checks exist up the chain, but their reasons do not carry over to this version. It needs its own check.",
    };
  }

  // Inherited: collect every independent fact-check that supports the same verdict.
  const inherited = v.all.filter((o): o is Extract<PathOutcome, { status: "inherited" }> => o.status === "inherited");
  const supporting = inherited
    .map(ref)
    .sort((a, b) => a.hops - b.hops)
    // One entry per fact-check URL (the same fact-check can be reached by two paths).
    .filter((r, i, all) => all.findIndex((x) => x.url === r.url) === i);
  const publishers = new Set(supporting.map((r) => r.publisher));

  const best = v.best;
  let confidence = best.confidence;

  if (publishers.size === 1) {
    confidence *= s.singleSourcePenalty;
    cautions.push(`Only one fact-checker (${[...publishers][0]}) supports this; confidence lowered.`);
  } else {
    cautions.push(`Corroborated by ${publishers.size} independent fact-checkers.`);
  }
  if (best.uncertainDirection) {
    confidence *= s.uncertainDirectionPenalty;
    cautions.push("At least one link on the path has an uncertain direction (dates unknown); confidence lowered.");
  }
  const weak = best.path.hops.filter((h) => h.confidence < s.weakLinkBelow);
  if (weak.length) {
    cautions.push(`${weak.length} link(s) on the path are weak (below ${s.weakLinkBelow}).`);
  }
  const lowTypes = new Set(best.path.hops.flatMap((h) => h.lowConfidenceTypes ?? []));
  if (lowTypes.size) {
    cautions.push(`Mutation label(s) ${[...lowTypes].join(", ")} are best-effort guesses.`);
  }

  return {
    kind: "inherited",
    verdict: best.verdict,
    basis: best.basis,
    confidence,
    rawConfidence: best.confidence,
    hops: best.hopCount,
    supporting,
    notCarried,
    cautions,
    explanation: best.explanation,
  };
}

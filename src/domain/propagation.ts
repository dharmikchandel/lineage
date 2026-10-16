// Verdict propagation (section 5 of the brief).
//
// Principle: a debunk travels exactly as far as its reason still applies.
//
// The graph does the traversal (query Q4 in src/graph/queries.ts returns every
// upward MUTATED_FROM path from a claim to a fact-checked ancestor). This file is
// the pure rule that walks one such path and decides whether the debunk survives
// each mutation on the way down. Keeping it pure means the rule table can be
// unit-tested without a database and read aloud line by line.

import {
  type DebunkBasis,
  type FactCheckVerdict,
  type MutationType,
  DEBUNK_BASES,
  NEGATIVE_VERDICTS,
} from "./types";

export interface PathClaim {
  id: string;
  text: string;
  /** Who this version says said it (e.g. "Bill Gates"), if anyone. */
  attributedTo?: string | null;
}

export interface PathHop {
  /** Mutation types on the edge child -> parent. */
  types: MutationType[];
  beforeText: string;
  afterText: string;
  /** The Linker's confidence that this edge is real. */
  confidence: number;
  directionCertain: boolean;
}

export interface PathFactCheck {
  url: string;
  publisher: string;
  date: string | null;
  verdict: FactCheckVerdict;
  basis: DebunkBasis | null;
}

/**
 * One upward path, as returned by Q4.
 * claims[0] is the claim being analysed; claims[last] is the fact-checked ancestor.
 * hops[i] is the edge claims[i] -[:MUTATED_FROM]-> claims[i+1].
 */
export interface InheritancePath {
  claims: PathClaim[];
  hops: PathHop[];
  factCheck: PathFactCheck;
  /** Names of sources the fact-check established as the TRUE origin of the checked claim. */
  establishedSources: string[];
}

export interface PropagationSettings {
  decay: number; // multiplied in on every hop (default 0.9)
  threshold: number; // stop when confidence drops below this (default 0.4)
  maxDepth: number; // never walk more hops than this (default 6)
}

export type PathOutcome =
  | {
      status: "inherited";
      verdict: FactCheckVerdict;
      basis: DebunkBasis;
      confidence: number;
      hopCount: number;
      uncertainDirection: boolean;
      explanation: string;
      path: InheritancePath;
    }
  | {
      status: "broken";
      /** Index into path.hops of the hop that broke the basis. */
      brokenAtHop: number;
      brokenBy: MutationType[];
      explanation: string;
      delta: { before: string; after: string };
      path: InheritancePath;
    }
  | {
      status: "correction";
      brokenAtHop: number;
      explanation: string;
      delta: { before: string; after: string };
      path: InheritancePath;
    }
  | {
      /** The parent's verdict is shown as context only; the claim needs its own check. */
      status: "context_only";
      reason: "basis_missing" | "not_negative" | "below_threshold" | "too_deep";
      confidence: number;
      explanation: string;
      path: InheritancePath;
    };

type HopRule = { survives: true } | { survives: false; correction: boolean; by: MutationType[]; reason: string };

/**
 * Which mutation types each debunk basis survives. Anything not listed BREAKS the
 * basis: when in doubt we do not assert an inherited debunk (fail safe, rule 3).
 */
export const SURVIVES: Record<DebunkBasis, readonly MutationType[] | "all"> = {
  // The event never happened. No rewording makes it happen.
  fabricated: "all",
  // The real author is known. Changing numbers, dates, tone or context does not change who said it.
  // attribution_change is handled specially below (it may be a correction).
  misattributed: ["number_change", "date_shift", "exaggeration", "context_stripped"],
  // The figure was wrong. Survives anything that keeps the figure.
  wrong_figure: ["date_shift", "exaggeration", "context_stripped", "attribution_change"],
  // The event is real but the date was wrong. A new date needs its own check.
  misdated: ["number_change", "attribution_change", "exaggeration"],
  // The claim overstated reality. Only further exaggeration keeps it overstated.
  overstated: ["exaggeration"],
  // The claim lacked context. Only still-stripped copies keep that problem.
  missing_context: ["context_stripped"],
};

const BASIS_REASON: Record<DebunkBasis, string> = {
  fabricated: "the event was fabricated, and no mutation makes it real",
  misattributed: "the real author is known, and this change does not alter who said it",
  wrong_figure: "the figure that was judged wrong is unchanged",
  misdated: "the date that was judged wrong is unchanged",
  overstated: "the claim is still (or more) overstated",
  missing_context: "the context is still missing",
};

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Decide whether one hop (one edge's set of mutation types) keeps the basis intact. */
export function checkHop(
  basis: DebunkBasis,
  hop: PathHop,
  child: PathClaim,
  establishedSources: string[],
): HopRule {
  const allowed = SURVIVES[basis];
  const breakers: MutationType[] = [];
  for (const t of hop.types) {
    if (allowed === "all" || allowed.includes(t)) continue;

    if (basis === "misattributed" && t === "attribution_change") {
      // Re-attribution to the ESTABLISHED true source is a correction, not a mutation to penalise.
      const target = child.attributedTo ? normalizeName(child.attributedTo) : "";
      const isTrueSource = target !== "" && establishedSources.some((s) => normalizeName(s) === target);
      if (isTrueSource) {
        return {
          survives: false,
          correction: true,
          by: [t],
          reason: `re-attributed to the established true source (${child.attributedTo}); this is a correction`,
        };
      }
    }
    breakers.push(t);
  }
  if (breakers.length === 0) return { survives: true };
  return {
    survives: false,
    correction: false,
    by: breakers,
    reason: `a ${breakers.join(" + ")} mutation means the "${basis}" debunk no longer covers this version`,
  };
}

/** Walk one path from the fact-checked ancestor down to the analysed claim. */
export function evaluatePath(path: InheritancePath, s: PropagationSettings): PathOutcome {
  const { factCheck, hops, claims } = path;

  if (!NEGATIVE_VERDICTS.includes(factCheck.verdict)) {
    return {
      status: "context_only",
      reason: "not_negative",
      confidence: 0,
      explanation: `An ancestor was rated "${factCheck.verdict}". Only negative verdicts are inherited; this needs its own check.`,
      path,
    };
  }
  const basis = factCheck.basis;
  if (!basis || !DEBUNK_BASES.includes(basis)) {
    return {
      status: "context_only",
      reason: "basis_missing",
      confidence: 0,
      explanation: `An ancestor was rated "${factCheck.verdict}", but the fact-check's basis is not recorded, so we cannot tell whether it still applies. Needs its own check.`,
      path,
    };
  }
  if (hops.length > s.maxDepth) {
    return {
      status: "context_only",
      reason: "too_deep",
      confidence: 0,
      explanation: `The fact-checked ancestor is ${hops.length} mutations away (limit ${s.maxDepth}).`,
      path,
    };
  }

  let confidence = 1;
  let uncertainDirection = false;
  // Walk DOWN the chain: start at the hop nearest the fact-checked ancestor.
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    const child = claims[i];
    const rule = checkHop(basis, hop, child, path.establishedSources);
    if (!rule.survives) {
      const delta = { before: hop.beforeText, after: hop.afterText };
      if (rule.correction) {
        return { status: "correction", brokenAtHop: i, explanation: `Not flagged: ${rule.reason}.`, delta, path };
      }
      return {
        status: "broken",
        brokenAtHop: i,
        brokenBy: rule.by,
        explanation: `The ancestor's debunk does not carry over: ${rule.reason}. Needs its own check.`,
        delta,
        path,
      };
    }
    confidence *= s.decay * hop.confidence;
    if (!hop.directionCertain) uncertainDirection = true;
    if (confidence < s.threshold) {
      return {
        status: "context_only",
        reason: "below_threshold",
        confidence,
        explanation: `The debunk's reason still applies, but after ${hops.length - i} hop(s) confidence fell to ${confidence.toFixed(2)}, below the ${s.threshold} threshold.`,
        path,
      };
    }
  }

  return {
    status: "inherited",
    verdict: factCheck.verdict,
    basis,
    confidence,
    hopCount: hops.length,
    uncertainDirection,
    explanation:
      hops.length === 0
        ? `Fact-checked directly: rated "${factCheck.verdict}" because ${BASIS_REASON[basis]}.`
        : `Inherited "${factCheck.verdict}" from a fact-checked ancestor ${hops.length} mutation(s) up: ` +
          `${BASIS_REASON[basis]}.`,
    path,
  };
}

export type DerivedVerdict =
  | { kind: "inherited"; best: Extract<PathOutcome, { status: "inherited" }>; all: PathOutcome[] }
  | { kind: "correction"; outcome: Extract<PathOutcome, { status: "correction" }>; all: PathOutcome[] }
  | { kind: "needs_own_check"; all: PathOutcome[] }
  | { kind: "unknown"; all: [] };

/**
 * Combine every path. A claim with two parents (a DAG merge) may inherit along
 * one path and not another; the strongest inherited path wins, and the others
 * are kept so the UI can show them.
 */
export function deriveVerdict(paths: InheritancePath[], s: PropagationSettings): DerivedVerdict {
  if (paths.length === 0) return { kind: "unknown", all: [] };
  const all = paths.map((p) => evaluatePath(p, s));
  const inherited = all.filter((o): o is Extract<PathOutcome, { status: "inherited" }> => o.status === "inherited");
  if (inherited.length > 0) {
    const best = inherited.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    return { kind: "inherited", best, all };
  }
  const correction = all.find((o): o is Extract<PathOutcome, { status: "correction" }> => o.status === "correction");
  if (correction) return { kind: "correction", outcome: correction, all };
  return { kind: "needs_own_check", all };
}

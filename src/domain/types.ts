// Shared vocabulary for the graph. These enums mirror sections 3-5 of the brief.

/** How a child claim differs from its parent. An edge may carry several. Extensible. */
export const MUTATION_TYPES = [
  "number_change",
  "date_shift",
  "context_stripped",
  "exaggeration",
  "attribution_change",
] as const;
export type MutationType = (typeof MUTATION_TYPES)[number];

/**
 * How reliably each mutation type can be detected from text. Used to cap the
 * confidence the Linker may assign. context_stripped is best-effort by design.
 */
export const MUTATION_RELIABILITY: Record<MutationType, number> = {
  number_change: 0.95,
  date_shift: 0.95,
  attribution_change: 0.9,
  exaggeration: 0.75,
  context_stripped: 0.5,
};

/** What a fact-check concluded. */
export const FACTCHECK_VERDICTS = ["false", "misleading", "misattributed", "unproven"] as const;
export type FactCheckVerdict = (typeof FACTCHECK_VERDICTS)[number];

/**
 * Only these verdicts may travel down a mutation chain (rule 1 of section 5).
 * "unproven" is shown as context but never inherited: it is not a debunk.
 */
export const NEGATIVE_VERDICTS: readonly FactCheckVerdict[] = ["false", "misleading", "misattributed"];

/** WHY a fact-check judged the claim false. This decides how far the debunk travels. */
export const DEBUNK_BASES = [
  "fabricated",
  "misattributed",
  "wrong_figure",
  "misdated",
  "overstated",
  "missing_context",
] as const;
export type DebunkBasis = (typeof DEBUNK_BASES)[number];

export const LINK_JUDGMENTS = ["same", "mutation", "related", "unrelated"] as const;
export type LinkJudgment = (typeof LINK_JUDGMENTS)[number];

export const PUBLISHER_KINDS = ["fake_news_site", "satire_site", "blog", "social_account", "outlet"] as const;
export type PublisherKind = (typeof PUBLISHER_KINDS)[number];

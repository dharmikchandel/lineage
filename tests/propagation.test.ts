// TEST FIXTURES ONLY. These paths are hand-written to exercise the section 5
// rules; they are not seed data and never touch the graph.
import { describe, expect, it } from "vitest";
import {
  type InheritancePath,
  type PathFactCheck,
  checkHop,
  deriveVerdict,
  evaluatePath,
} from "@/domain/propagation";

const settings = { decay: 0.9, threshold: 0.4, maxDepth: 6 };

function fc(partial: Partial<PathFactCheck>): PathFactCheck {
  return { url: "https://example.org/fixture", publisher: "Fixture", date: null, verdict: "false", basis: null, ...partial };
}

describe("worked case 1: NASA darkness (fabricated survives a number change)", () => {
  const path: InheritancePath = {
    claims: [
      { id: "c15", text: "NASA confirms 15 days of darkness in November." },
      { id: "c6", text: "NASA confirms 6 days of darkness in December." },
    ],
    hops: [
      {
        types: ["number_change", "date_shift"],
        beforeText: "6 days of darkness in December",
        afterText: "15 days of darkness in November",
        confidence: 0.95,
        directionCertain: true,
      },
    ],
    factCheck: fc({ basis: "fabricated" }),
    establishedSources: [],
  };

  it("inherits the debunk with decayed confidence", () => {
    const out = evaluatePath(path, settings);
    expect(out.status).toBe("inherited");
    if (out.status !== "inherited") return;
    expect(out.basis).toBe("fabricated");
    expect(out.confidence).toBeCloseTo(0.9 * 0.95);
    expect(out.hopCount).toBe(1);
  });
});

describe("worked case 2: wrong_figure is broken by a corrected figure", () => {
  const path: InheritancePath = {
    claims: [
      { id: "fixed", text: "The flood killed 12 people." },
      { id: "wrong", text: "The flood killed 1,200 people." },
    ],
    hops: [
      {
        types: ["number_change"],
        beforeText: "killed 1,200 people",
        afterText: "killed 12 people",
        confidence: 0.95,
        directionCertain: true,
      },
    ],
    factCheck: fc({ basis: "wrong_figure" }),
    establishedSources: [],
  };

  it("does not inherit, names the breaking mutation, and shows the delta", () => {
    const out = evaluatePath(path, settings);
    expect(out.status).toBe("broken");
    if (out.status !== "broken") return;
    expect(out.brokenBy).toEqual(["number_change"]);
    expect(out.brokenAtHop).toBe(0);
    expect(out.delta).toEqual({ before: "killed 1,200 people", after: "killed 12 people" });
  });
});

describe("worked case 3: misattributed quote re-attributed to its true author", () => {
  const base = (attributedTo: string): InheritancePath => ({
    claims: [
      { id: "child", text: `"Life is not fair; get used to it." (${attributedTo})`, attributedTo },
      { id: "gates", text: `"Life is not fair; get used to it." (Bill Gates)`, attributedTo: "Bill Gates" },
    ],
    hops: [
      {
        types: ["attribution_change"],
        beforeText: "Bill Gates",
        afterText: attributedTo,
        confidence: 0.9,
        directionCertain: true,
      },
    ],
    factCheck: fc({ verdict: "misattributed", basis: "misattributed" }),
    establishedSources: ["Charles J. Sykes"],
  });

  it("treats re-attribution to the established source as a correction", () => {
    const out = evaluatePath(base("Charles J. Sykes"), settings);
    expect(out.status).toBe("correction");
    expect(deriveVerdict([base("Charles J. Sykes")], settings).kind).toBe("correction");
  });

  it("matches names loosely (case and punctuation)", () => {
    expect(evaluatePath(base("charles j sykes"), settings).status).toBe("correction");
  });

  it("re-attribution to someone else breaks the basis instead (needs its own check)", () => {
    const out = evaluatePath(base("Albert Einstein"), settings);
    expect(out.status).toBe("broken");
  });

  it("a number change keeps a misattribution debunk", () => {
    const p = base("Bill Gates");
    p.hops[0].types = ["number_change"];
    expect(evaluatePath(p, settings).status).toBe("inherited");
  });
});

describe("global rules", () => {
  const chain = (n: number, basis: PathFactCheck["basis"], verdict: PathFactCheck["verdict"] = "false"): InheritancePath => ({
    claims: Array.from({ length: n + 1 }, (_, i) => ({ id: `c${i}`, text: `claim ${i}` })),
    hops: Array.from({ length: n }, () => ({
      types: ["date_shift" as const],
      beforeText: "a",
      afterText: "b",
      confidence: 1,
      directionCertain: true,
    })),
    factCheck: fc({ basis, verdict }),
    establishedSources: [],
  });

  it("only negative verdicts propagate", () => {
    const out = evaluatePath(chain(1, "fabricated", "unproven"), settings);
    expect(out.status).toBe("context_only");
  });

  it("fails safe when the basis is missing", () => {
    const out = evaluatePath(chain(1, null), settings);
    expect(out).toMatchObject({ status: "context_only", reason: "basis_missing" });
  });

  it("decays per hop and stops below the threshold", () => {
    // 0.9^8 = 0.43, 0.9^9 = 0.387: with maxDepth high, 9 hops falls below 0.4.
    const loose = { ...settings, maxDepth: 20 };
    expect(evaluatePath(chain(8, "fabricated"), loose).status).toBe("inherited");
    expect(evaluatePath(chain(9, "fabricated"), loose)).toMatchObject({ status: "context_only", reason: "below_threshold" });
  });

  it("caps depth", () => {
    expect(evaluatePath(chain(7, "fabricated"), settings)).toMatchObject({ status: "context_only", reason: "too_deep" });
  });

  it("reports the hop nearest the analysed claim that broke it, walking down from the ancestor", () => {
    const p = chain(3, "misdated");
    // hops[2] is nearest the ancestor (fine: number change); hops[1] shifts the date (breaks).
    p.hops[2].types = ["number_change"];
    const out = evaluatePath(p, settings);
    expect(out).toMatchObject({ status: "broken", brokenAtHop: 1, brokenBy: ["date_shift"] });
  });

  it("a direct fact-check (zero hops) is returned at full confidence", () => {
    const out = evaluatePath(chain(0, "fabricated"), settings);
    expect(out).toMatchObject({ status: "inherited", confidence: 1, hopCount: 0 });
  });

  it("with two parents, the strongest inherited path wins", () => {
    const strong = chain(1, "fabricated");
    const broken = chain(1, "misdated"); // date_shift breaks misdated
    const v = deriveVerdict([broken, strong], settings);
    expect(v.kind).toBe("inherited");
  });

  it("no paths means unknown", () => {
    expect(deriveVerdict([], settings).kind).toBe("unknown");
  });

  it("every type on one edge must survive", () => {
    const hop = { types: ["date_shift", "number_change"] as const, beforeText: "", afterText: "", confidence: 1, directionCertain: true };
    const r = checkHop("wrong_figure", { ...hop, types: [...hop.types] }, { id: "x", text: "" }, []);
    expect(r).toMatchObject({ survives: false, by: ["number_change"] });
  });
});

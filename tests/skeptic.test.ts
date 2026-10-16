// TEST FIXTURES ONLY: hand-written paths, never seeded into the graph.
import { describe, expect, it } from "vitest";
import { type InheritancePath, deriveVerdict } from "@/domain/propagation";
import { assess } from "@/domain/skeptic";

const settings = { decay: 0.9, threshold: 0.4, maxDepth: 6 };

function path(publisher: string, url: string, opts: { directionCertain?: boolean; confidence?: number } = {}): InheritancePath {
  return {
    claims: [
      { id: "new", text: "new" },
      { id: "old", text: "old" },
    ],
    hops: [
      {
        types: ["date_shift"],
        beforeText: "2017",
        afterText: "2026",
        confidence: opts.confidence ?? 1,
        directionCertain: opts.directionCertain ?? true,
      },
    ],
    factCheck: { url, publisher, date: null, verdict: "false", basis: "fabricated" },
    establishedSources: [],
  };
}

const notContested = { contested: false, names: [] };

describe("skeptic", () => {
  it("lowers confidence when only one fact-checker supports the verdict", () => {
    const a = assess(deriveVerdict([path("PolitiFact", "u1")], settings), notContested);
    expect(a.rawConfidence).toBeCloseTo(0.9);
    expect(a.confidence).toBeCloseTo(0.81);
    expect(a.cautions.join(" ")).toMatch(/Only one fact-checker/);
  });

  it("does not raise confidence when corroborated, but says so", () => {
    const a = assess(deriveVerdict([path("PolitiFact", "u1"), path("FactCheck.org", "u2")], settings), notContested);
    expect(a.confidence).toBeCloseTo(0.9);
    expect(a.supporting).toHaveLength(2);
    expect(a.cautions.join(" ")).toMatch(/Corroborated by 2/);
  });

  it("lowers confidence for an uncertain direction and flags weak links", () => {
    const a = assess(deriveVerdict([path("A", "u1", { directionCertain: false, confidence: 0.5 }), path("B", "u2")], settings), notContested);
    // The strongest path (B, certain direction) wins, so no direction penalty applies.
    expect(a.confidence).toBeCloseTo(0.9);
    const b = assess(deriveVerdict([path("A", "u1", { directionCertain: false })], settings), notContested);
    expect(b.confidence).toBeCloseTo(0.9 * 0.9 * 0.9);
  });

  it("reports a contested origin", () => {
    const a = assess(deriveVerdict([path("A", "u1")], settings), { contested: true, names: ["Huzlers.com", "2012 email"] });
    expect(a.cautions[0]).toMatch(/contested/);
  });

  it("returns unknown with no verdict and no sources", () => {
    const a = assess(deriveVerdict([], settings), notContested);
    expect(a).toMatchObject({ kind: "unknown", verdict: null, confidence: 0, supporting: [] });
  });

  it("lists debunks that did not carry over, with the reason and delta", () => {
    const p = path("A", "u1");
    p.factCheck.basis = "misdated";
    const a = assess(deriveVerdict([p], settings), notContested);
    expect(a.kind).toBe("needs_own_check");
    expect(a.notCarried[0].delta).toEqual({ before: "2017", after: "2026" });
  });
});

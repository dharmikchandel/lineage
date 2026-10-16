import { describe, expect, it } from "vitest";
import { groundingProblem } from "@/agents/writer";

const sheet = { claim: "NASA says 15 days of darkness in November 2026", confidence: 0.81, versions_in_story: 7, first_seen: "2012-12" };

describe("writer grounding check", () => {
  it("accepts numbers that are in the fact sheet", () => {
    expect(groundingProblem("A 2026 rewrite of a 2012 hoax, 7 versions, confidence 0.81, 15 days.", sheet)).toBeNull();
  });
  it("rejects a number the fact sheet does not contain", () => {
    expect(groundingProblem("Shared 300,000 times.", sheet)).toMatch(/300/);
  });
  it("rejects a percentage rewrite of the confidence", () => {
    expect(groundingProblem("We are 81% sure.", sheet)).toMatch(/81/);
  });
  it("rejects URLs", () => {
    expect(groundingProblem("See www.snopes.com", sheet)).toMatch(/URL/);
  });
});

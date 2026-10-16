// Agent 3: Skeptic (rule-based, 0 API calls).
//
// For each claim the Linker wrote, the Skeptic:
//   - runs Q4 (inherited verdict) and Q2 (origins) against the graph,
//   - applies the propagation rules and its own checks (src/domain/skeptic.ts),
//   - writes one "assessment" finding per claim, which the Writer reads back.
// It never raises confidence and never creates a verdict the graph does not support.

import { config } from "@/lib/config";
import { q2Origins, q4InheritancePaths } from "@/graph/queries";
import { deriveVerdict } from "@/domain/propagation";
import { type Assessment, assess } from "@/domain/skeptic";
import type { LinkOutcome } from "./linker";
import { readFindings, runAgent } from "./trace";

export interface ClaimAssessment extends Assessment {
  claimId: string;
  text: string;
  linkStatus: LinkOutcome["status"];
}

export async function runSkeptic(analysisId: string): Promise<ClaimAssessment[]> {
  return runAgent({ analysisId, agent: "skeptic", seq: 3, method: "rule-based" }, async (ctx) => {
    const linked = (await readFindings<LinkOutcome>(analysisId, "linker", "linked_claim")).map((f) => f.data);
    const out: ClaimAssessment[] = [];

    for (const c of linked) {
      const verdict = deriveVerdict(await q4InheritancePaths(c.claimId), config.propagation);
      const origins = await q2Origins(c.claimId);
      const names = [...new Set(origins.rows.flatMap((r) => r.origins.map((o) => o.name)))];
      const a: ClaimAssessment = {
        claimId: c.claimId,
        text: c.text,
        linkStatus: c.status,
        ...assess(verdict, { contested: origins.contested, names }),
      };
      out.push(a);

      const headline =
        a.kind === "inherited"
          ? `${a.verdict} (basis ${a.basis}), confidence ${a.confidence.toFixed(2)} after ${a.hops} hop(s)`
          : a.kind === "unknown"
            ? "unknown: nothing in the graph"
            : a.kind === "correction"
              ? "correction: re-attributed to the established source"
              : "needs its own check: the ancestor's reason does not carry over";
      await ctx.find("assessment", headline, a, [c.claimId]);
      for (const caution of a.cautions) await ctx.find("caution", caution, { claimId: c.claimId }, [c.claimId]);
    }
    return out;
  });
}

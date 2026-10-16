// GET /api/lineage/[claimId]: the whole story family around a claim, for drawing.
// Every node's colour comes from a live Q4 traversal; nothing is stored as truth.
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { q5FamilyOf, q4InheritancePaths, viewFamily } from "@/graph/queries";
import { deriveVerdict } from "@/domain/propagation";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ claimId: string }> }) {
  const { claimId } = await params;
  try {
    const family = await q5FamilyOf(claimId);
    const ids = family?.claimIds ?? [claimId];
    const view = await viewFamily(ids);
    const claims = await Promise.all(
      view.claims.map(async (c) => {
        const v = deriveVerdict(await q4InheritancePaths(c.id), config.propagation);
        const status =
          v.kind === "inherited"
            ? v.best.hopCount === 0
              ? "checked"
              : "inherited"
            : v.kind;
        return {
          ...c,
          status,
          verdict: v.kind === "inherited" ? v.best.verdict : null,
          basis: v.kind === "inherited" ? v.best.basis : null,
          confidence: v.kind === "inherited" ? v.best.confidence : null,
        };
      }),
    );
    return NextResponse.json({
      focusId: claimId,
      family: family ? { variants: family.variants, firstSeen: family.firstSeen, lastSeen: family.lastSeen } : null,
      claims,
      edges: view.edges,
      origins: view.origins,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

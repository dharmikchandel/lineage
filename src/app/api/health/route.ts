// GET /api/health: is FalkorDB reachable, and does the graph hold data?
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { graphCounts } from "@/graph/queries";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const counts = await graphCounts();
    return NextResponse.json({
      ok: true,
      empty: counts.claims === 0,
      counts,
      mode: config.mode,
      model: config.llm.model,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

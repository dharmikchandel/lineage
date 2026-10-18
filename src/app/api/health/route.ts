// GET /api/health: is FalkorDB reachable, and does the graph hold data?
// In recorded mode it also says which recorded preset runs are loaded in the graph.
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { graphCounts } from "@/graph/queries";
import { errorResponse } from "@/lib/http";
import { loadedRecordedRuns, readManifest, recordedAnalysisId } from "@/recorded";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const counts = await graphCounts();
    let recorded = null;
    if (config.mode === "recorded") {
      const m = await readManifest();
      const loaded = m ? await loadedRecordedRuns(m.presets) : [];
      recorded = m && {
        on: m.recordedOn,
        model: m.model,
        runs: Object.fromEntries(loaded.map((p) => [p, recordedAnalysisId(p)])),
      };
    }
    return NextResponse.json({
      ok: true,
      empty: counts.claims === 0,
      counts,
      mode: config.mode,
      model: config.llm.model,
      recorded,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

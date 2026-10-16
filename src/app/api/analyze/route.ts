// POST /api/analyze { text } -> { analysisId }
// Starts the four agents in the background and returns at once; the page then
// polls /api/analysis/[id], which reads the live trace back from the graph.
// Local mode only: the public deployment (recorded mode) never calls the LLM.
import { NextResponse, after } from "next/server";
import { config } from "@/lib/config";
import { errorResponse } from "@/lib/http";
import { graphCounts } from "@/graph/queries";
import { newAnalysisId, runAnalysis } from "@/pipeline";

export const dynamic = "force-dynamic";

const MAX_INPUT_CHARS = 2000;
// One analysis at a time keeps us inside the free-tier rate limit.
let running: string | null = null;

export async function POST(req: Request) {
  if (config.mode !== "local") {
    return NextResponse.json({ error: "Free-text analysis runs only in local mode. Try a preset." }, { status: 403 });
  }
  let body: { text?: unknown; synthetic?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON: { text }" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length < 10) return NextResponse.json({ error: "Paste a claim of at least 10 characters." }, { status: 400 });
  if (text.length > MAX_INPUT_CHARS) return NextResponse.json({ error: `Keep it under ${MAX_INPUT_CHARS} characters.` }, { status: 400 });
  if (running) return NextResponse.json({ error: "Another analysis is still running.", analysisId: running }, { status: 409 });

  try {
    if ((await graphCounts()).claims === 0) {
      return NextResponse.json({ error: "The graph is empty. Run `pnpm schema && pnpm seed`." }, { status: 503 });
    }
  } catch (err) {
    return errorResponse(err);
  }

  const analysisId = newAnalysisId();
  running = analysisId;
  after(async () => {
    try {
      await runAnalysis(text, { analysisId, synthetic: body.synthetic === true });
    } catch (err) {
      // The failing agent already recorded status=error on its AgentRun node,
      // which is what the page shows. Log for the terminal too.
      console.error(`analysis ${analysisId} failed:`, err instanceof Error ? err.message : err);
    } finally {
      running = null;
    }
  });
  return NextResponse.json({ analysisId });
}

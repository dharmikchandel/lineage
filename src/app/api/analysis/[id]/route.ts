// GET /api/analysis/[id]: the agent trace and final answers, read from the graph.
import { NextResponse } from "next/server";
import { readFindings, readTrace } from "@/agents/trace";
import type { Answer } from "@/agents/writer";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

const AGENTS = ["extractor", "linker", "skeptic", "writer"] as const;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const trace = await readTrace(id);
    const failed = trace.find((r) => r.status === "error");
    const writer = trace.find((r) => r.agent === "writer");
    const status = failed ? "error" : writer?.status === "ok" ? "done" : "running";
    const answers = status === "done" ? (await readFindings<Answer>(id, "writer", "answer")).map((f) => f.data) : [];
    return NextResponse.json({
      analysisId: id,
      status,
      error: failed?.error ?? null,
      agents: AGENTS.map((name) => trace.find((r) => r.agent === name) ?? { agent: name, status: "waiting", findings: [] }),
      answers,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

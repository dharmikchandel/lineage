// Agent coordination through the graph (Track 2).
//
// Agents never call each other or pass objects in memory. Each agent:
//   1. opens an AgentRun node,
//   2. reads the previous agent's Findings back FROM THE GRAPH,
//   3. writes its own Findings (and any Claims / edges) to the graph,
//   4. closes its AgentRun with status, provider, model and cache use.
// The UI replays the trace by reading the same nodes.

import { read } from "@/lib/db";
import { addFinding, finishAgentRun, startAgentRun } from "@/graph/writes";

export type AgentName = "extractor" | "linker" | "skeptic" | "writer";

export interface AgentContext {
  analysisId: string;
  runId: string;
  /** Record what this agent found. `about` links the finding to Claim nodes. */
  find(kind: string, summary: string, data: unknown, about?: string[]): Promise<string>;
  /** Report which provider answered (and whether from cache) for the trace. */
  setProvider(p: { provider: string; model: string; cached: boolean }): void;
}

export async function runAgent<T>(
  opts: { analysisId: string; agent: AgentName; seq: number; method: "llm" | "rule-based" },
  body: (ctx: AgentContext) => Promise<T>,
): Promise<T> {
  const runId = await startAgentRun({ ...opts, mode: "live" });
  const providers: { provider: string; model: string; cached: boolean }[] = [];
  const ctx: AgentContext = {
    analysisId: opts.analysisId,
    runId,
    find: (kind, summary, data, about) => addFinding({ runId, kind, summary, data, aboutClaimIds: about }),
    setProvider: (p) => providers.push(p),
  };
  try {
    const out = await body(ctx);
    await finishAgentRun(runId, {
      status: "ok",
      provider: providers.map((p) => p.provider).join(",") || (opts.method === "rule-based" ? "rule-based" : null),
      model: providers.map((p) => p.model).join(",") || null,
      cached: providers.length > 0 && providers.every((p) => p.cached),
    });
    return out;
  } catch (err) {
    await finishAgentRun(runId, { status: "error", error: err instanceof Error ? err.message : String(err) }).catch(() => {});
    throw err;
  }
}

/** Read one agent's findings for this analysis back from the graph. */
export async function readFindings<T = unknown>(analysisId: string, agent: AgentName, kind: string) {
  const rows = await read<{ id: string; summary: string; data: string }>(
    // Findings written by `agent` during this analysis, in the order they were written.
    `MATCH (a:AgentRun {analysis_id: $analysisId, agent: $agent})-[:FOUND]->(f:Finding {kind: $kind})
     RETURN f.id AS id, f.summary AS summary, f.data AS data
     ORDER BY f.at`,
    { analysisId, agent, kind },
  );
  return rows.map((r) => ({ id: r.id, summary: r.summary, data: JSON.parse(r.data) as T }));
}

/** The full trace for an analysis, for the UI. */
export async function readTrace(analysisId: string) {
  return read<{
    agent: string;
    seq: number;
    method: string;
    mode: string;
    status: string;
    provider: string | null;
    model: string | null;
    cached: boolean;
    error: string | null;
    findings: { kind: string; summary: string }[];
  }>(
    `MATCH (a:AgentRun {analysis_id: $analysisId})
     OPTIONAL MATCH (a)-[:FOUND]->(f:Finding)
     WITH a, f ORDER BY f.at
     RETURN a.agent AS agent, a.seq AS seq, a.method AS method, a.mode AS mode, a.status AS status,
            a.provider AS provider, a.model AS model, a.cached AS cached, a.error AS error,
            collect(CASE WHEN f IS NULL THEN NULL ELSE {kind: f.kind, summary: f.summary} END) AS findings
     ORDER BY seq`,
    { analysisId },
  );
}

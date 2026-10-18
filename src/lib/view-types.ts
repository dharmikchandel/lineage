// Shapes of the API responses, as the browser sees them.
import type { Answer } from "@/agents/writer";
import type { ViewClaim, ViewEdge, ViewOrigin } from "@/graph/queries";

export type { Answer };

export type Health =
  | {
      ok: true;
      empty: boolean;
      counts: { claims: number; factChecks: number; withEmbedding: number };
      mode: "local" | "recorded";
      model: string;
      /** Recorded mode only: when and with which model the runs were recorded, and preset id -> analysis id for each run loaded in the graph. */
      recorded: { on: string; model: string; runs: Record<string, string> } | null;
    }
  | { ok?: false; error: string; graphDown?: boolean };

export interface AgentRow {
  agent: "extractor" | "linker" | "skeptic" | "writer";
  status: "waiting" | "running" | "ok" | "error";
  method?: "llm" | "rule-based";
  mode?: "live" | "recorded";
  provider?: string | null;
  model?: string | null;
  cached?: boolean;
  error?: string | null;
  findings: { kind: string; summary: string }[];
}

export interface AnalysisView {
  analysisId: string;
  status: "running" | "done" | "error";
  error: string | null;
  agents: AgentRow[];
  answers: Answer[];
}

export type NodeStatus = "checked" | "inherited" | "needs_own_check" | "correction" | "unknown";

export interface LineageClaim extends ViewClaim {
  status: NodeStatus;
  verdict: string | null;
  basis: string | null;
  confidence: number | null;
}

export interface LineageView {
  focusId: string;
  family: { variants: number; firstSeen: string | null; lastSeen: string | null } | null;
  claims: LineageClaim[];
  edges: ViewEdge[];
  origins: ViewOrigin[];
}

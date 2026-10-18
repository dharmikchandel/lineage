"use client";
// Recorded runs arrive finished. This plays the stored trace back one step at a time,
// at roughly the pace of a live run, so the public demo reads the same way. Nothing is
// invented: each step shows exactly the AgentRun / Finding nodes read from the graph.

import { useEffect, useMemo, useState } from "react";
import type { AgentRow, AnalysisView } from "@/lib/view-types";
import { SHOWN_FINDINGS } from "./AgentTrace";

const START_MS = 380;
const FINDING_MS = 460;
const FINISH_MS = 300;

/** One delay per step: an agent starts, each visible finding appears, the agent finishes. */
function replaySteps(a: AnalysisView): number[] {
  return a.agents.flatMap((r) => [START_MS, ...r.findings.filter((f) => SHOWN_FINDINGS.has(f.kind)).map(() => FINDING_MS), FINISH_MS]);
}

/** The analysis as it looked after `step` steps. */
function atStep(a: AnalysisView, step: number): AnalysisView {
  let left = step;
  const agents = a.agents.map((r): AgentRow => {
    if (left <= 0) return { ...r, status: "waiting", findings: [] };
    left -= 1;
    const visible = r.findings.filter((f) => SHOWN_FINDINGS.has(f.kind)).length;
    const shown = Math.min(left, visible);
    left -= shown;
    if (left <= 0) {
      // Keep findings up to the `shown`-th visible one (hidden kinds ride along).
      let seen = 0;
      const findings = r.findings.filter((f) => (SHOWN_FINDINGS.has(f.kind) ? ++seen <= shown : seen < shown));
      return { ...r, status: "running", findings };
    }
    left -= 1;
    return r;
  });
  const finished = step >= replaySteps(a).length;
  return { ...a, agents, status: finished ? a.status : "running", answers: finished ? a.answers : [] };
}

export function isRecordedRun(a: AnalysisView | null): boolean {
  return a !== null && a.agents.length > 0 && a.agents.every((r) => r.mode === "recorded");
}

/** Plays a finished recorded run back; returns other analyses unchanged. */
export function useReplay(analysis: AnalysisView | null): AnalysisView | null {
  const steps = useMemo(() => (analysis && analysis.status === "done" && isRecordedRun(analysis) ? replaySteps(analysis) : null), [analysis]);
  const [progress, setProgress] = useState<{ id: string; step: number } | null>(null);

  useEffect(() => {
    if (!analysis || !steps) return;
    const id = analysis.analysisId;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setProgress({ id, step: steps.length });
      return;
    }
    let step = 0;
    let timer: ReturnType<typeof setTimeout>;
    setProgress({ id, step });
    const next = () => {
      step += 1;
      setProgress({ id, step });
      if (step < steps.length) timer = setTimeout(next, steps[step]);
    };
    timer = setTimeout(next, steps[0]);
    return () => clearTimeout(timer);
  }, [analysis, steps]);

  if (!analysis || !steps) return analysis;
  return atStep(analysis, progress?.id === analysis.analysisId ? progress.step : 0);
}

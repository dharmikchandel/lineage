"use client";
// The four agents, replayed from AgentRun / Finding nodes in the graph.
// AgentTrace is the full list; Pipeline is the big live view shown while agents work.

import {
  Check, CircleCheck, CircleDashed, CircleX, Gauge, GitBranch, Link2, LoaderCircle, PenLine, Quote, Scale,
  ScanSearch, Search, Split, TriangleAlert, Waypoints, X,
  type LucideIcon,
} from "lucide-react";
import type { AgentRow } from "@/lib/view-types";

export const AGENT_META: Record<AgentRow["agent"], { icon: LucideIcon; role: string }> = {
  extractor: { icon: ScanSearch, role: "Splits the text into checkable claims" },
  linker: { icon: Waypoints, role: "Finds relatives in the graph and labels each mutation" },
  skeptic: { icon: Scale, role: "Checks which debunks still apply, lowers confidence" },
  writer: { icon: PenLine, role: "Writes the answer from graph findings only" },
};

const FINDING_ICON: Record<string, LucideIcon> = {
  atomic_claim: Quote,
  no_claims: CircleDashed,
  candidates: Search,
  nearest_versions: GitBranch,
  link_mutation: Split,
  link_same: Link2,
  link_none: CircleDashed,
  link_refused: CircleX,
  assessment: Gauge,
  caution: TriangleAlert,
  grounding_rejected: CircleX,
  answer: CircleCheck,
};

export const SHOWN_FINDINGS = new Set(Object.keys(FINDING_ICON));

const EMPTY: AgentRow[] = (["extractor", "linker", "skeptic", "writer"] as const).map((agent) => ({ agent, status: "waiting", findings: [] }));

/** The agent working right now: the graph says "running", or the first one not yet started while the run is live. */
export function withLiveStatus(agents: AgentRow[] | null, live: boolean): AgentRow[] {
  const rows = agents ?? EMPTY;
  if (!live || rows.some((r) => r.status === "running")) return rows;
  const next = rows.findIndex((r) => r.status === "waiting");
  return rows.map((r, i) => (i === next ? { ...r, status: "running" } : r));
}

function Method({ r }: { r: AgentRow }) {
  if (r.method === "rule-based" || r.agent === "skeptic") return <span className="tag rule">rule-based · no LLM</span>;
  if (!r.provider) return null;
  return <span className="tag">{r.model ?? r.provider}</span>;
}

function StatusIcon({ r }: { r: AgentRow }) {
  if (r.status === "running") return <LoaderCircle size={14} className="spin" />;
  if (r.status === "ok") return <Check size={14} strokeWidth={2.4} />;
  if (r.status === "error") return <X size={14} strokeWidth={2.4} />;
  const Icon = AGENT_META[r.agent].icon;
  return <Icon size={13} />;
}

export function AgentTrace({ agents, live }: { agents: AgentRow[] | null; live: boolean }) {
  const rows = withLiveStatus(agents, live);
  return (
    <section className="panel" aria-label="Agent trace">
      <div className="panel-head">
        <h2><Waypoints size={15} /> Agent trace</h2>
        <span>read back from the graph</span>
      </div>
      <div className="panel-body">
        <ol className="trace">
          {rows.map((r) => (
            <li key={r.agent} className={`agent ${r.status}`}>
              <span className="a-ico" aria-hidden><StatusIcon r={r} /></span>
              <div>
                <div className="a-head">
                  <span className="a-name">{r.agent}</span>
                  <Method r={r} />
                  {r.cached && <span className="tag cache" title="This step's model output came from the local cache">cache</span>}
                  {r.mode === "recorded" && <span className="tag recorded">recorded</span>}
                  <span className="sr-only">status: {r.status}</span>
                </div>
                <div className="a-role">{AGENT_META[r.agent].role}</div>
                {r.findings.some((f) => SHOWN_FINDINGS.has(f.kind)) && (
                  <ul className="findings">
                    {r.findings
                      .filter((f) => SHOWN_FINDINGS.has(f.kind))
                      .map((f, j) => {
                        const Icon = FINDING_ICON[f.kind];
                        return (
                          <li key={j} className={`finding k-${f.kind}`}>
                            <Icon size={13} aria-hidden />
                            <span>{f.summary}</span>
                          </li>
                        );
                      })}
                  </ul>
                )}
                {r.error && <div className="a-error">{r.error}</div>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** The big live view inside the stage while the agents work. */
export function Pipeline({ agents, live }: { agents: AgentRow[] | null; live: boolean }) {
  const rows = withLiveStatus(agents, live);
  const active = rows.find((r) => r.status === "running") ?? [...rows].reverse().find((r) => r.status === "ok");
  const latest = active ? [...active.findings].reverse().find((f) => SHOWN_FINDINGS.has(f.kind)) : undefined;

  return (
    <div className="pipeline" aria-live="polite">
      <div className="pipe-row">
        {rows.map((r) => {
          const Icon = AGENT_META[r.agent].icon;
          return (
            <div key={r.agent} className={`pipe-step ${r.status}`}>
              <div className="pipe-node">{r.status === "ok" ? <Check size={20} strokeWidth={2.2} /> : <Icon size={20} />}</div>
              <div className="pipe-name">{r.agent}</div>
              <div className="pipe-method">{r.agent === "skeptic" ? "rules, no LLM" : r.status === "ok" && r.cached ? "LLM · from cache" : "LLM"}</div>
            </div>
          );
        })}
      </div>
      <div className="pipe-ticker">
        {latest ? (
          <p key={latest.summary}>
            <small>{active?.agent} · {latest.kind.replace(/_/g, " ")}</small>
            {latest.summary}
          </p>
        ) : (
          <p><small>starting</small>Opening an analysis in the graph…</p>
        )}
      </div>
    </div>
  );
}

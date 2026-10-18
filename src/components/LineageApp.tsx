"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight, CircleDashed, Database, GitBranch, History, Info, LoaderCircle, Plus, ShieldCheck, Split, TriangleAlert, Unplug, type LucideIcon,
} from "lucide-react";
import { PRESETS } from "@/lib/presets";
import type { AnalysisView, Health, LineageView } from "@/lib/view-types";
import { AgentTrace, Pipeline } from "./AgentTrace";
import { AnswerPanel, fmtDate } from "./AnswerPanel";
import { LineageGraph, revealDuration } from "./LineageGraph";
import { AmbientTree } from "./AmbientTree";
import { Mark } from "./Mark";
import { isRecordedRun, useReplay } from "./replay";

const POLL_MS = 700;

const PRESET_ICON: Record<string, LucideIcon> = {
  "nasa-2026": Split,
  "nasa-second": GitBranch,
  "gates-correction": ShieldCheck,
  unrelated: CircleDashed,
};

async function getJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch(url, { cache: "no-store", ...init });
  return { ok: res.ok, status: res.status, body: (await res.json()) as T };
}

export function LineageApp() {
  const [health, setHealth] = useState<Health | null>(null);
  const [text, setText] = useState("");
  const [presetId, setPresetId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [active, setActive] = useState(0);
  const [lineage, setLineage] = useState<LineageView | null>(null);
  const [lineageError, setLineageError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const newTrace = useRef<() => void>(null);

  const refreshHealth = useCallback(async () => {
    try {
      const r = await getJson<Health>("/api/health");
      setHealth(r.body);
    } catch {
      setHealth({ error: "The Lineage server is not responding." });
    }
  }, []);

  useEffect(() => {
    refreshHealth();
    // A finished analysis can be reopened by link: /?analysis=<id>
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("analysis");
    if (fromUrl) setAnalysisId(fromUrl);
    // A demo claim can be preloaded by link: /?preset=nasa-2026
    const preset = PRESETS.find((p) => p.id === params.get("preset"));
    if (!fromUrl && preset) {
      setText(preset.text);
      setPresetId(preset.id);
    }
  }, [refreshHealth]);

  // "/" jumps to the composer, like most command bars.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        input.current?.focus();
      }
      if (e.key.toLowerCase() === "n") newTrace.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Poll the trace while the agents work. Every poll is a fresh read of the graph.
  useEffect(() => {
    if (!analysisId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await getJson<AnalysisView & { error?: string; graphDown?: boolean }>(`/api/analysis/${analysisId}`);
        if (stopped) return;
        if (!r.ok) {
          setSubmitError(r.body.error ?? "Could not read the analysis from the graph.");
          if (r.body.graphDown) refreshHealth();
          return;
        }
        setAnalysis(r.body);
        if (r.body.status === "running") timer.current = setTimeout(tick, POLL_MS);
        else refreshHealth();
      } catch {
        if (!stopped) setSubmitError("Lost contact with the Lineage server.");
      }
    };
    tick();
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [analysisId, refreshHealth]);

  // A recorded run is played back step by step; a live one is shown as polled.
  const view = useReplay(analysis);

  // Once answered, fetch the family tree around the selected claim (live graph queries).
  const focusId = view?.status === "done" ? view.answers[active]?.claimId : undefined;
  useEffect(() => {
    if (!focusId) return;
    let stopped = false;
    setLineage(null);
    setLineageError(null);
    getJson<LineageView & { error?: string }>(`/api/lineage/${encodeURIComponent(focusId)}`)
      .then((r) => {
        if (stopped) return;
        if (r.ok) setLineage(r.body);
        else setLineageError(r.body.error ?? "Could not load the lineage.");
      })
      .catch(() => !stopped && setLineageError("Could not load the lineage."));
    return () => {
      stopped = true;
    };
  }, [focusId]);

  const live = view?.status === "running" || (analysisId !== null && view === null);
  const ok = health !== null && "ok" in health && health.ok;
  const graphDown = health !== null && !ok;
  const empty = ok && health.empty;
  const recorded = ok && health.mode === "recorded";
  const rec = ok ? health.recorded : null;
  const recordedLabel = rec ? `Recorded run: ${fmtDate(rec.on)}, ${rec.model}` : "Recorded run";
  const recordedId = presetId ? rec?.runs[presetId] : undefined;
  const canSubmit = !live && !graphDown && !empty && (recorded ? Boolean(recordedId) : text.trim().length >= 10);

  // Recorded mode: open the preset's recorded run (already in the graph) instead of calling the agents.
  function openRecorded(claim: string, id: string) {
    setSubmitError(null);
    setAnalysis(null);
    setLineage(null);
    setActive(0);
    setSubmitted(claim);
    setAnalysisId(id);
    window.history.replaceState(null, "", `?analysis=${id}`);
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canSubmit) return;
    if (recorded) {
      if (recordedId) openRecorded(text.trim(), recordedId);
      return;
    }
    setSubmitError(null);
    setAnalysis(null);
    setLineage(null);
    setActive(0);
    try {
      const r = await getJson<{ analysisId?: string; error?: string; graphDown?: boolean }>("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, synthetic: presetId !== null }),
      });
      if (!r.ok || !r.body.analysisId) {
        setSubmitError(r.body.error ?? `Request failed (${r.status}).`);
        if (r.body.graphDown || r.status === 503) refreshHealth();
        return;
      }
      setSubmitted(text.trim());
      setAnalysisId(r.body.analysisId);
      window.history.replaceState(null, "", `?analysis=${r.body.analysisId}`);
    } catch {
      setSubmitError("Could not reach the Lineage server.");
    }
  }

  function reset() {
    if (timer.current) clearTimeout(timer.current);
    setAnalysisId(null);
    setAnalysis(null);
    setLineage(null);
    setSubmitError(null);
    setSubmitted(null);
    window.history.replaceState(null, "", "/");
    setTimeout(() => input.current?.focus(), 50);
  }

  newTrace.current = reset;

  function choosePreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setText(p.text);
    setPresetId(p.id);
    if (recorded) {
      const id = rec?.runs[p.id];
      if (id) openRecorded(p.text, id);
      else setSubmitError("This recorded run is not in the graph yet. Run pnpm seed with LINEAGE_MODE=recorded.");
      return;
    }
    input.current?.focus();
  }

  const answers = view?.status === "done" ? view.answers : [];
  const recordedRun = isRecordedRun(analysis);
  const answer = answers[active];
  const query =
    submitted ??
    view?.agents.find((a) => a.agent === "extractor")?.findings.find((f) => f.kind === "atomic_claim")?.summary ??
    "Loading analysis…";
  const reveal = lineage ? revealDuration(lineage) : 0;

  return (
    <div className="app">
      <div className="field" aria-hidden />
      <header className="topbar">
        <div className="wrap">
          <button className="brand" onClick={reset} aria-label="Lineage, start a new trace">
            <Mark className="brand-mark" />
            Lineage <small>claim ancestry, traced in a graph</small>
          </button>
          <div className="status">
            {health === null ? (
              <span className="pill"><span className="dot" /> connecting</span>
            ) : ok ? (
              <span className="pill live" title="Every answer is computed live from this graph">
                <span className="dot" /> <Database size={12} /> FalkorDB · <span className="num">{health.counts.claims}</span> claims
              </span>
            ) : (
              <span className="pill down"><Unplug size={12} /> FalkorDB unreachable</span>
            )}
            {ok && <span className={`pill mode ${health.mode}`}>{health.mode === "local" ? health.model : "recorded runs"}</span>}
          </div>
        </div>
      </header>

      <main className="wrap">
        {graphDown && (
          <div className="alert" role="alert">
            <Unplug size={18} />
            <div>
              <strong>Lineage cannot work without its graph.</strong>
              {"error" in health! ? health.error : ""} Every claim, edge and verdict lives in FalkorDB; there is no fallback store.
            </div>
          </div>
        )}
        {empty && (
          <div className="alert" role="alert">
            <Database size={18} />
            <div>
              <strong>The graph is empty.</strong> Run <code>pnpm schema &amp;&amp; pnpm seed</code> to load the seed stories.
            </div>
          </div>
        )}

        {!analysisId ? (
          <section className="hero">
            <AmbientTree />
            <h1>
              A claim is never new.
              <span>It is a mutation of something older.</span>
            </h1>
            <p className="lede">
              Paste a claim from a reel, a forward or a headline. Four agents trace its family tree through a graph: where it came from, how it
              mutated, and which debunks still apply.
            </p>

            <form className="composer" onSubmit={submit}>
              <label htmlFor="claim" className="sr-only">Claim to trace</label>
              <textarea
                id="claim"
                ref={input}
                value={text}
                placeholder={recorded ? "This public demo replays recorded runs. Pick a demo claim below." : "NASA confirms Earth will go dark for 15 days in November…"}
                onChange={(e) => {
                  setText(e.target.value);
                  setPresetId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
                }}
                disabled={recorded}
                autoFocus
              />
              <div className="composer-foot">
                <div className="composer-note">
                  {recorded ? (
                    <>
                      <History size={13} /> Agent steps are replayed from real runs; every graph query runs live. To trace your own text, run Lineage locally.
                    </>
                  ) : presetId ? (
                    <>
                      <span className="tag synthetic">synthetic demo data</span> a made-up test input, never a real article
                    </>
                  ) : (
                    <>
                      <Info size={13} /> Text is sent to Google Gemini, and on the free tier Google may use it to improve its products. Don't paste private information.
                    </>
                  )}
                </div>
                {!recorded && (
                  <div className="composer-actions">
                    <span className="kbd" aria-hidden><kbd>Ctrl</kbd><kbd>↵</kbd></span>
                    <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
                      Trace lineage <ArrowRight size={14} />
                    </button>
                  </div>
                )}
              </div>
            </form>
            {submitError && <p className="error" role="alert"><TriangleAlert size={14} /> {submitError}</p>}

            <div className="suggest">
              <h2>{recorded ? "Replay a recorded run" : "Try a demo claim"}</h2>
              <ul>
                {PRESETS.map((p) => {
                  const Icon = PRESET_ICON[p.id] ?? Split;
                  return (
                    <li key={p.id}>
                      <button type="button" onClick={() => choosePreset(p.id)} aria-pressed={presetId === p.id}>
                        <span className="ico"><Icon size={15} /></span>
                        <span>
                          <span className="t">{p.label}</span>
                          <span className="h">{p.hint}</span>
                        </span>
                        <span className="go"><span className="tag synthetic">synthetic</span><ArrowRight size={14} /></span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        ) : (
          <section className="workspace">
            <div className="bar">
              <div className="q">
                {live ? <LoaderCircle size={15} className="spin" /> : <Split size={15} />}
                <span title={query}>{query}</span>
                {answer?.synthetic && <span className="tag synthetic">synthetic</span>}
                {recordedRun && <span className="tag recorded" title="The agents' model replies were recorded; the graph queries run live"><History size={11} /> {recordedLabel}</span>}
              </div>
              <button className="btn btn-ghost" onClick={reset} title="New trace (N)"><Plus size={14} /> <span>New trace</span> <span className="kbd" aria-hidden><kbd>N</kbd></span></button>
            </div>
            {submitError && <p className="error" role="alert"><TriangleAlert size={14} /> {submitError}</p>}

            <div className="stage">
              {view?.status === "error" ? (
                <div className="empty-note" role="alert"><TriangleAlert size={16} /> An agent failed: {view.error}</div>
              ) : lineage && lineage.claims.length > 0 ? (
                <LineageGraph key={lineage.focusId} view={lineage} whatTheGraphDid={answer?.whatTheGraphDid} />
              ) : view?.status === "done" && answers.length === 0 ? (
                <div className="empty-note">No checkable claim was found in that text.</div>
              ) : (
                <Pipeline agents={view?.agents ?? null} live={live} />
              )}
              {lineageError && <p className="error" style={{ padding: "0 18px 18px" }}>{lineageError}</p>}
            </div>

            <div className="lower">
              <AgentTrace agents={view?.agents ?? null} live={live} recordedLabel={recordedRun ? recordedLabel : undefined} />
              {answers.length > 0 ? (
                <AnswerPanel answers={answers} active={active} onSelect={setActive} revealDelay={reveal} />
              ) : (
                <section className="panel" aria-label="Answer">
                  <div className="panel-head"><h2><Info size={15} /> Inspector</h2><span>waiting for the Writer</span></div>
                  <div className="panel-body sk" aria-hidden>
                    <i style={{ width: "45%", height: 22 }} />
                    <i style={{ width: "100%", height: 54, borderRadius: 12 }} />
                    <i style={{ width: "80%" }} />
                    <i style={{ width: "92%" }} />
                    <i style={{ width: "64%" }} />
                  </div>
                </section>
              )}
            </div>
          </section>
        )}
      </main>

      <footer className="footer">
        <div className="wrap">
          <span>
            <Database size={12} />{" "}
            {recorded
              ? "Agent steps are recorded runs. The lineage graph and its verdicts are queried live from FalkorDB on every view."
              : "Every answer is computed live from FalkorDB. Verdicts are derived by traversal, never stored as truth."}
          </span>
          <span>Graph Hacks 2026</span>
        </div>
      </footer>
    </div>
  );
}

"use client";
// The inspector: derived verdict + basis + confidence + trail, or "Unknown".
// Never a bare true/false (brief, section 12).

import { useEffect, useState } from "react";
import { ArrowUpRight, Info, PenLine, ShieldAlert, ShieldCheck, ShieldQuestionMark, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Answer } from "@/lib/view-types";
import { FlipNumber } from "./FlipNumber";

const VERDICT: Record<string, { icon: LucideIcon; title: string; sub: string }> = {
  checked: { icon: ShieldAlert, title: "Fact-checked directly", sub: "This exact claim has been debunked" },
  inherited: { icon: ShieldAlert, title: "Debunk carries over", sub: "An ancestor's debunk still applies to this version" },
  correction: { icon: ShieldCheck, title: "A correction", sub: "It credits the established true source" },
  needs_own_check: { icon: TriangleAlert, title: "Needs its own check", sub: "Related debunks exist, but their reason no longer applies" },
  unknown: { icon: ShieldQuestionMark, title: "Unknown", sub: "No evidence in the graph, so Lineage does not guess" },
};

const BASIS_LABEL: Record<string, string> = {
  fabricated: "fabricated · never happened",
  misattributed: "misattributed · wrong author",
  wrong_figure: "wrong figure",
  misdated: "wrong date",
  overstated: "overstated",
  missing_context: "missing context",
};

export function fmtDate(d: string | null) {
  if (!d) return "undated";
  const [y, m, day] = d.split("-");
  if (!m) return y;
  const month = new Date(Number(y), Number(m) - 1, 1).toLocaleString("en", { month: "short" });
  return day ? `${Number(day)} ${month} ${y}` : `${month} ${y}`;
}

const hopsText = (h: number) => (h === 0 ? "on this claim" : `${h} hop${h === 1 ? "" : "s"} up`);

export function AnswerPanel({ answers, active, onSelect, revealDelay = 0 }: { answers: Answer[]; active: number; onSelect: (i: number) => void; revealDelay?: number }) {
  const a = answers[active];
  // The meter fills once the graph's reveal has played, so the eye follows the debunk.
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    setFilled(false);
    const t = setTimeout(() => setFilled(true), revealDelay + 80);
    return () => clearTimeout(t);
  }, [a?.claimId, revealDelay]);
  if (!a) return null;

  const tone = a.kind === "inherited" && a.hops === 0 ? "checked" : a.kind;
  const v = VERDICT[tone];
  const Icon = v.icon;
  const broken = a.notCarried.filter((n) => n.delta);
  const tooFar = a.notCarried.filter((n) => !n.delta);

  return (
    <section className="panel" aria-label="Answer" aria-live="polite">
      <div className="panel-head">
        <h2><Info size={15} /> Inspector</h2>
        {answers.length > 1 ? (
          <div className="tabs" role="tablist">
            {answers.map((x, i) => (
              <button key={x.claimId} role="tab" aria-selected={i === active} onClick={() => onSelect(i)}>
                Claim {i + 1}
              </button>
            ))}
          </div>
        ) : (
          <span>derived at query time</span>
        )}
      </div>
      <div className="panel-body">
        <div className="verdict">
          <div className={`v-ico t-${tone}`}><Icon size={18} /></div>
          <div>
            <p className={`v-label t-${tone}`}>{v.title}</p>
            <p>{v.sub}</p>
          </div>
          {a.synthetic && <span className="tag synthetic v-syn">synthetic demo data</span>}
        </div>
        <h3 className="headline">{a.headline}</h3>
        <p className="summary">{a.summary}</p>
        <p className="written">
          <PenLine size={12} />
          {a.writtenBy === "llm" ? "Worded by the Writer from the graph's facts only" : "Template answer built from the graph's facts"}
        </p>

        {a.kind === "inherited" && (
          <div className="conf">
            <div className="conf-num"><FlipNumber value={a.confidence.toFixed(2)} delay={revealDelay} /></div>
            <div className="conf-label">
              <span>confidence</span>
              {a.rawConfidence !== a.confidence && <span className="num">Q4 {a.rawConfidence.toFixed(2)} → Skeptic {a.confidence.toFixed(2)}</span>}
            </div>
            <div className="meter" role="img" aria-label={`confidence ${a.confidence.toFixed(2)} of 1`}>
              <span className="raw" style={{ transform: `scaleX(${filled ? a.rawConfidence : 0})` }} />
              <span className="val" style={{ transform: `scaleX(${filled ? a.confidence : 0})` }} />
            </div>
          </div>
        )}
        {a.kind === "inherited" && (
          <div className="chips">
            <span className="tag ember">verdict · {a.verdict}</span>
            {a.basis && <span className="tag">basis · {BASIS_LABEL[a.basis] ?? a.basis}</span>}
            <span className="tag">{a.hops === 0 ? "checked directly" : `${a.hops} mutation hop${a.hops === 1 ? "" : "s"}`}</span>
          </div>
        )}


        {a.supporting.length > 0 && (
          <div className="sect">
            <h4><span>Fact-checks whose reason still applies</span><span className="num">{a.supporting.length}</span></h4>
            <ul className="rows">
              {a.supporting.map((s) => (
                <li key={s.url}>
                  <a className="row" href={s.url} target="_blank" rel="noreferrer">
                    <span className="p">{s.publisher} <ArrowUpRight size={13} /></span>
                    <span className="r">{hopsText(s.hops)}</span>
                    <span className="m">{fmtDate(s.date)} · {s.verdict}{s.basis ? ` · ${s.basis}` : ""}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {a.corrects && (
          <div className="sect">
            <h4>Corrects a version debunked by</h4>
            <ul className="rows">
              <li>
                <a className="row" href={a.corrects.url} target="_blank" rel="noreferrer">
                  <span className="p">{a.corrects.publisher} <ArrowUpRight size={13} /></span>
                  <span className="r">{hopsText(a.corrects.hops)}</span>
                  <span className="m">{fmtDate(a.corrects.date)} · {a.corrects.verdict}</span>
                </a>
              </li>
            </ul>
          </div>
        )}

        {[
          { title: "Debunks that do not carry over", items: broken },
          { title: "Further up the chain, not counted", items: tooFar },
        ].map(
          (g) =>
            g.items.length > 0 && (
              <div className="sect" key={g.title}>
                <h4>{g.title}</h4>
                <ul className="rows">
                  {g.items.slice(0, 4).map((n, i) => (
                    <li key={i}>
                      <a className="row" href={n.factCheck.url} target="_blank" rel="noreferrer">
                        <span className="p">{n.factCheck.publisher} <ArrowUpRight size={13} /></span>
                        <span className="r">{hopsText(n.factCheck.hops)}</span>
                        <span className="why">{n.reason}</span>
                        {n.delta && (
                          <span className="why delta"><del>{n.delta.before}</del> → <ins>{n.delta.after}</ins></span>
                        )}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ),
        )}

        {a.origins.list.length > 0 && (
          <div className="sect">
            <div className={`origin-card ${a.origins.contested ? "contested" : ""}`}>
              <h5>{a.origins.contested && <TriangleAlert size={14} />}{a.origins.contested ? "Origin contested" : "Origin"}</h5>
              <ul>
                {a.origins.list.map((o) => (
                  <li key={o.name}>
                    {o.name}
                    <span>confidence {o.confidence} · <a href={o.evidenceUrl} target="_blank" rel="noreferrer">evidence</a></span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {a.cautions.length > 0 && (
          <div className="sect">
            <h4>Skeptic's notes</h4>
            <ul className="cautions">
              {a.cautions.map((c, i) => {
                // Corroboration is reassurance, not a warning.
                const good = c.startsWith("Corroborated");
                return (
                  <li key={i} className={good ? "good" : undefined}>
                    {good ? <ShieldCheck size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />} <span>{c}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

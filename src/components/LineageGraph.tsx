"use client";
// The lineage, drawn as a dated timeline.
//   x: claims ordered by first-seen date (ordinal columns, so a 9-year gap does not eat the screen)
//   y: the analysed claim's chain on the top lane, side branches below
//   edges: child -> parent ("mutated from"), labelled with mutation types;
//          red where a debunk flows through the edge
// Node colours come from a live Q4 traversal per claim (see /api/lineage).
//
// Reveal: columns fade in oldest -> newest, edges draw themselves, then a pulse
// travels each red edge from the debunked ancestor to the claim it now covers.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Expand, GitBranch, Network, Shrink, Sparkle } from "lucide-react";
import type { LineageClaim, LineageView, NodeStatus } from "@/lib/view-types";
import { fmtDate } from "./AnswerPanel";

const COL_W = 216;
const NODE_W = 160;
const NODE_H = 116;
const LANE_H = 150;
const TOP = 30;
const COL_STAGGER = 110; // ms between columns appearing
const PULSE_MS = 900;

const SHORT: Record<string, string> = {
  number_change: "number",
  date_shift: "date",
  context_stripped: "context",
  exaggeration: "inflated",
  attribution_change: "attrib.",
};

const STATUS_TEXT: Record<NodeStatus, (c: LineageClaim) => string> = {
  checked: () => "fact-checked",
  inherited: (c) => `inherited ${c.confidence?.toFixed(2) ?? ""}`,
  needs_own_check: () => "needs own check",
  correction: () => "correction",
  unknown: () => "no fact-check",
};

interface Placed {
  claim: LineageClaim;
  col: number;
  lane: number;
  x: number;
  y: number;
}

function layout(view: LineageView) {
  const byId = new Map(view.claims.map((c) => [c.id, c]));
  const parentsOf = new Map<string, typeof view.edges>();
  for (const e of view.edges) parentsOf.set(e.child, [...(parentsOf.get(e.child) ?? []), e]);

  // Undated claims sit in their parent's column.
  const key = (c: LineageClaim, seen = new Set<string>()): string => {
    if (c.firstSeen) return c.firstSeen;
    if (seen.has(c.id)) return "9999";
    seen.add(c.id);
    const p = (parentsOf.get(c.id) ?? []).map((e) => byId.get(e.parent)).find(Boolean);
    return p ? key(p, seen) : "9999";
  };
  const keys = [...new Set(view.claims.map((c) => key(c)))].sort();
  const originCols = view.origins.length > 0 ? 1 : 0;

  // Main chain: from the focus claim, follow the most confident parent to the root.
  const mainChain = new Set<string>();
  let cur: string | undefined = view.focusId;
  while (cur && !mainChain.has(cur) && byId.has(cur)) {
    mainChain.add(cur);
    const ps: typeof view.edges = [...(parentsOf.get(cur) ?? [])].sort((a, b) => b.confidence - a.confidence);
    cur = ps[0]?.parent;
  }

  const used = new Map<number, Set<number>>();
  const placed = new Map<string, Placed>();
  const sorted = [...view.claims].sort((a, b) => key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
  for (const c of [...sorted.filter((c) => mainChain.has(c.id)), ...sorted.filter((c) => !mainChain.has(c.id))]) {
    const col = keys.indexOf(key(c)) + originCols;
    const lanes = used.get(col) ?? new Set<number>();
    let lane = mainChain.has(c.id) ? 0 : 1;
    while (lanes.has(lane)) lane++;
    lanes.add(lane);
    used.set(col, lanes);
    placed.set(c.id, { claim: c, col, lane, x: col * COL_W, y: TOP + lane * LANE_H });
  }

  const maxLane = Math.max(0, ...[...placed.values()].map((p) => p.lane), view.origins.length - 1);
  const width = (keys.length + originCols) * COL_W - (COL_W - NODE_W);
  const height = TOP + (maxLane + 1) * LANE_H - (LANE_H - NODE_H) + 4;

  const axis = keys.map((k, i) => ({ col: i + originCols, x: (i + originCols) * COL_W + NODE_W / 2, label: k === "9999" ? "undated" : fmtDate(k) }));
  const gaps = keys.slice(1).flatMap((k, i) => {
    const years = Number(k.slice(0, 4)) - Number(keys[i].slice(0, 4));
    return years >= 3 && k !== "9999" ? [{ col: i + 1 + originCols, x: (i + 1 + originCols) * COL_W - (COL_W - NODE_W) / 2, years }] : [];
  });

  return { placed, width, height, axis, gaps };
}

function edgeGeometry(from: Placed, to: Placed) {
  // from = child (newer, right), to = parent (older, left)
  if (from.col === to.col) {
    const x = from.x + NODE_W / 2;
    const y1 = from.y;
    const y2 = to.y + NODE_H;
    return { d: `M ${x} ${y1} L ${x} ${y2 + 7}`, mx: x + 40, my: (y1 + y2) / 2 };
  }
  const x1 = from.x;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x + NODE_W + 7;
  const y2 = to.y + NODE_H / 2;
  const c = Math.max(40, (x1 - x2) / 2);
  return { d: `M ${x1} ${y1} C ${x1 - c} ${y1}, ${x2 + c} ${y2}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
}

const flows = (child: NodeStatus, parent: NodeStatus) => child === "inherited" && (parent === "checked" || parent === "inherited");

/** How long the reveal takes, so other panels can land in step with it. */
export function revealDuration(view: LineageView): number {
  const { placed } = layout(view);
  const cols = Math.max(0, ...[...placed.values()].map((p) => p.col));
  const red = view.edges.filter((e) => {
    const a = placed.get(e.child);
    const b = placed.get(e.parent);
    return a && b && flows(a.claim.status, b.claim.status);
  }).length;
  return cols * COL_STAGGER + 500 + (red > 0 ? PULSE_MS + 200 : 0);
}

export function LineageGraph({ view, whatTheGraphDid }: { view: LineageView; whatTheGraphDid?: string }) {
  const [selected, setSelected] = useState<string>(view.focusId);
  const { placed, width, height, axis, gaps } = useMemo(() => layout(view), [view]);
  const sel = view.claims.find((c) => c.id === selected) ?? view.claims[0];

  const narrow = useNarrow();
  const colDelay = (col: number) => col * COL_STAGGER;
  const edgesDone = Math.max(0, ...[...placed.values()].map((p) => p.col)) * COL_STAGGER + 500;

  // Fit the whole tree, origin to newest claim, when it stays legible (scale >= 0.7).
  // Otherwise (or when the viewer picks "actual size") the canvas scrolls.
  const scroller = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  const [fitPref, setFitPref] = useState(true);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth - 44));
    ro.observe(el);
    return () => ro.disconnect();
  }, [narrow]);
  const fitScale = avail > 0 ? Math.min(1, avail / width) : 1;
  const canFit = fitScale >= 0.7;
  const scale = fitPref && canFit ? fitScale : 1;
  const overflows = avail > 0 && width > avail;
  // Older/Newer controls and edge fades only matter when the canvas actually scrolls.
  const scrolling = scale >= 1 && overflows;

  // When it scrolls, the story still reads oldest -> newest: open on the oldest versions and
  // glide right to the analysed claim while the columns reveal. A user scroll or reduced motion stops it.
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = () => {
    const el = scroller.current;
    if (el) setEdges({ left: el.scrollLeft > 8, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 8 });
  };
  useEffect(() => {
    const el = scroller.current;
    const focus = placed.get(view.focusId);
    if (!el || !focus) return;
    const target = scale < 1 ? 0 : Math.max(0, focus.x + NODE_W + 40 - el.clientWidth);
    if (target === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.scrollLeft = target;
      updateEdges();
      return;
    }
    el.scrollLeft = 0;
    let raf = 0;
    let cancelled = false;
    const stop = () => (cancelled = true);
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("pointerdown", stop);
    const start = performance.now() + 300;
    const dur = Math.max(900, edgesDone);
    const step = (now: number) => {
      if (cancelled) return;
      const t = Math.min(1, Math.max(0, (now - start) / dur));
      el.scrollLeft = target * (1 - Math.pow(1 - t, 3));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("wheel", stop);
      el.removeEventListener("pointerdown", stop);
    };
  }, [placed, view.focusId, edgesDone, narrow, scale]);
  const nudge = (dir: -1 | 1) => scroller.current?.scrollBy({ left: dir * COL_W * 2, behavior: "smooth" });

  // Red edges, in the order the debunk travels (oldest parent first).
  const red = view.edges
    .map((e) => ({ e, a: placed.get(e.child), b: placed.get(e.parent) }))
    .filter((x): x is { e: (typeof view.edges)[number]; a: Placed; b: Placed } => !!x.a && !!x.b && flows(x.a.claim.status, x.b.claim.status))
    .sort((x, y) => x.b.col - y.b.col);
  const focusPulse = red.find((x) => x.e.child === view.focusId);
  const igniteAt = focusPulse ? edgesDone + PULSE_MS - 120 : edgesDone;
  const focusTone = placed.get(view.focusId)?.claim.status;
  const ignites = focusTone === "inherited" || focusTone === "correction";

  const origins = view.origins.map((o, i) => ({ o, x: 0, y: TOP + i * LANE_H }));
  const contested = new Set(view.origins.map((o) => o.name)).size > 1;
  const span =
    view.family?.firstSeen && view.family?.lastSeen
      ? Number(view.family.lastSeen.slice(0, 4)) - Number(view.family.firstSeen.slice(0, 4))
      : null;
  const d = (ms: number) => ({ ["--d" as string]: `${ms}ms` });

  return (
    <>
      <div className="stage-head">
        <h2><Network size={15} /> Family tree</h2>
        <div className="stage-meta">
          <span className="num">{view.claims.length} variant{view.claims.length === 1 ? "" : "s"}{span !== null ? ` · ${span} years` : ""}</span>
          {contested && <span className="tag amber">origin contested</span>}
          {!narrow && overflows && canFit && (
            <button className="btn btn-ghost btn-sm" onClick={() => setFitPref((f) => !f)} aria-pressed={!fitPref}>
              {fitPref ? <><Expand size={13} /> Actual size</> : <><Shrink size={13} /> Fit to view</>}
            </button>
          )}
        </div>
      </div>
      <div className="legend">
        <span><i style={{ background: "var(--ember)" }} /> debunk applies</span>
        <span><i style={{ background: "var(--amber)" }} /> needs own check</span>
        <span><i style={{ background: "var(--mint)" }} /> correction</span>
        <span><i style={{ background: "var(--slate)" }} /> no verdict</span>
        <span><i style={{ border: "1px dashed var(--violet)" }} /> synthetic</span>
        <span><ArrowRight size={12} style={{ transform: "scaleX(-1)" }} /> points to the version it mutated from</span>
      </div>

      {narrow ? (
        <VerticalLineage view={view} selected={sel?.id} onSelect={setSelected} />
      ) : (
        <div className={`graph-wrap ${scrolling && edges.left ? "fade-l" : ""} ${scrolling && edges.right ? "fade-r" : ""}`}>
          {scrolling && edges.left && (
            <button className="graph-nav left" onClick={() => nudge(-1)} aria-label="Scroll to older versions">
              <ArrowLeft size={13} /> Older
            </button>
          )}
          {scrolling && edges.right && (
            <button className="graph-nav right" onClick={() => nudge(1)} aria-label="Scroll to newer versions">
              Newer <ArrowRight size={13} />
            </button>
          )}
          <div className="graph-scroll" ref={scroller} onScroll={updateEdges}>
            <div style={{ width: width * scale, height: height * scale, overflow: scale < 1 ? "hidden" : undefined }}>
              <div className="graph-canvas" style={{ width, height, transform: scale < 1 ? `scale(${scale})` : undefined, transformOrigin: "0 0" }}>
                <svg className="edges" width={width} height={height} aria-hidden>
                  <defs>
                    <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(255 255 255 / 0.4)" />
                    </marker>
                    <marker id="arr-red" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="#ff6a3d" />
                    </marker>
                    <marker id="arr-amber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="#f5b544" />
                    </marker>
                  </defs>
                  {view.edges.map((e) => {
                    const a = placed.get(e.child);
                    const b = placed.get(e.parent);
                    if (!a || !b) return null;
                    const g = edgeGeometry(a, b);
                    const isRed = flows(a.claim.status, b.claim.status);
                    return (
                      <path
                        key={`${e.child}-${e.parent}`}
                        d={g.d}
                        pathLength={e.directionCertain ? 1 : undefined}
                        className={`edge ${isRed ? "red" : ""} ${e.directionCertain ? "" : "uncertain"}`}
                        style={{ ...d(colDelay(a.col) + 120), opacity: e.directionCertain ? 0.45 + 0.55 * (e.confidence ?? 1) : undefined }}
                        markerEnd={isRed ? "url(#arr-red)" : "url(#arr)"}
                      />
                    );
                  })}
                  {origins.map(({ o, x, y }) => {
                    const target = placed.get(o.claimId);
                    if (!target) return null;
                    const x1 = x + NODE_W;
                    const y1 = y + NODE_H / 2;
                    const x2 = target.x;
                    const y2 = target.y + NODE_H / 2;
                    return (
                      <path
                        key={`o-${o.name}`}
                        d={`M ${x2} ${y2} C ${x2 - 60} ${y2}, ${x1 + 60} ${y1}, ${x1 + 7} ${y1}`}
                        className="edge origin"
                        style={d(colDelay(target.col) + 200)}
                        markerEnd="url(#arr-amber)"
                      />
                    );
                  })}
                </svg>

                {red.map(({ e, a, b }, i) => (
                  <span
                    key={`p-${e.child}`}
                    className="pulse"
                    style={{ offsetPath: `path("${edgeGeometry(a, b).d}")`, ...d(edgesDone + i * 140) }}
                    aria-hidden
                  />
                ))}

                {axis.map((a) => (
                  <span key={a.x} className="axis" style={{ left: a.x, ...d(colDelay(a.col)) }}>{a.label}</span>
                ))}
                {gaps.map((g) => (
                  <span key={`g${g.x}`} className="axis gap" style={{ left: g.x, ...d(colDelay(g.col)) }}>+{g.years} yrs</span>
                ))}
                {origins.length > 0 && (
                  <span className="axis origin" style={{ left: NODE_W / 2 }}>{contested ? "origin contested" : "origin"}</span>
                )}

                {origins.map(({ o, x, y }) => (
                  <div key={o.name} className="o-node" style={{ left: x, top: y, width: NODE_W, minHeight: NODE_H }}>
                    <span className="k">{o.label === "Publisher" ? "first publisher?" : "earlier source?"} · {o.confidence}</span>
                    <b>{o.name}</b>
                    <a href={o.evidenceUrl} target="_blank" rel="noreferrer">evidence <ArrowUpRight size={11} /></a>
                  </div>
                ))}

                {[...placed.values()].map(({ claim: c, x, y, col }) => {
                  const publishers = new Set(c.sightings.map((s) => s.publisher).filter(Boolean)).size;
                  const isFocus = c.id === view.focusId;
                  return (
                    <button
                      key={c.id}
                      className={`g-node s-${c.status} ${c.synthetic ? "synthetic" : ""} ${isFocus ? "focus" : ""} ${isFocus && ignites ? "ignite" : ""} ${c.id === sel?.id ? "selected" : ""}`}
                      style={{ left: x, top: y, width: NODE_W, height: NODE_H, ...d(colDelay(col)), ["--ignite" as string]: `${igniteAt}ms` }}
                      onClick={() => setSelected(c.id)}
                      aria-pressed={c.id === sel?.id}
                      aria-label={`${fmtDate(c.firstSeen)}: ${c.text}. ${STATUS_TEXT[c.status](c)}`}
                    >
                      <span className="top">
                        <span>{fmtDate(c.firstSeen)}</span>
                        {c.synthetic && <span className="tag synthetic">synthetic</span>}
                      </span>
                      <span className="txt">{c.text}</span>
                      <span className="foot">
                        <span className="state"><i />{STATUS_TEXT[c.status](c)}</span>
                        {publishers > 0 && <span>· {publishers} pub.</span>}
                      </span>
                    </button>
                  );
                })}

                {view.edges.map((e) => {
                  const a = placed.get(e.child);
                  const b = placed.get(e.parent);
                  if (!a || !b) return null;
                  const g = edgeGeometry(a, b);
                  const low = new Set(e.lowConfidenceTypes ?? []);
                  const isRed = flows(a.claim.status, b.claim.status);
                  return (
                    <div key={`l-${e.child}-${e.parent}`} className="mut-stack" style={{ left: g.mx, top: g.my, ...d(colDelay(a.col) + 380) }}>
                      {(e.types ?? []).map((t) => (
                        <span key={t} className={`mut ${isRed ? "red" : ""} ${low.has(t) ? "low" : ""}`} title={low.has(t) ? "best-effort label" : t}>
                          {SHORT[t] ?? t}{low.has(t) ? "?" : ""}
                        </span>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {whatTheGraphDid && (
        <div className="hud" style={d(narrow ? 0 : igniteAt + 200)}>
          <span className="ico"><Sparkle size={17} /></span>
          <div>
            <h3>What the graph did</h3>
            <p>{whatTheGraphDid}</p>
          </div>
        </div>
      )}

      {sel && <ClaimDetails key={sel.id} claim={sel} view={view} />}
    </>
  );
}

function ClaimDetails({ claim, view }: { claim: LineageClaim; view: LineageView }) {
  const byId = new Map(view.claims.map((c) => [c.id, c]));
  const up = view.edges.filter((e) => e.child === claim.id);
  const down = view.edges.filter((e) => e.parent === claim.id);
  const origins = view.origins.filter((o) => o.claimId === claim.id);
  const tone =
    claim.status === "unknown" ? "" : claim.status === "needs_own_check" ? "amber" : claim.status === "correction" ? "mint" : "ember";

  return (
    <div className="details">
      <div>
        <div className="chips" style={{ marginTop: 0 }}>
          <span className="tag num">{fmtDate(claim.firstSeen)}</span>
          <span className={`tag ${tone}`}>{STATUS_TEXT[claim.status](claim)}</span>
          {claim.basis && <span className="tag">basis · {claim.basis}</span>}
          {claim.synthetic && <span className="tag synthetic">synthetic demo data</span>}
        </div>
        <h4>{claim.text}</h4>
        {claim.attributedTo && <p className="written" style={{ marginTop: -4, marginBottom: 12 }}>Attributed to {claim.attributedTo}</p>}

        {up.map((e) => (
          <div key={e.parent} className="edge-card sect">
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
              <GitBranch size={13} /> Mutated from the <b style={{ color: "var(--text)", fontWeight: 500 }}>{fmtDate(byId.get(e.parent)?.firstSeen ?? null)}</b> version
            </div>
            <span className="delta"><del>{e.beforeText}</del><ArrowRight size={12} /><ins>{e.afterText}</ins></span>
            <div className="meta">
              {(e.types ?? []).join(" · ")} · confidence {e.confidence} · by {e.assertedBy}
              {e.directionCertain ? "" : " · direction uncertain"}
            </div>
            {e.note && <div className="meta" style={{ fontFamily: "var(--sans)" }}>{e.note}</div>}
          </div>
        ))}
        {down.length > 0 && <p className="written">{down.length} later version{down.length === 1 ? "" : "s"} mutated from this one.</p>}

        {claim.factChecks.length > 0 && (
          <div className="sect">
            <h4>Fact-checks on this version</h4>
            <ul className="rows">
              {claim.factChecks.map((f) => (
                <li key={f.url}>
                  <a className="row" href={f.url} target="_blank" rel="noreferrer">
                    <span className="p">{f.publisher} <ArrowUpRight size={13} /></span>
                    <span className="r">{fmtDate(f.date)}</span>
                    <span className="why">{f.verdict} · {f.basis} · {f.summary}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div>
        <div className="sect" style={{ marginTop: 0 }}>
          <h4><span>Sightings</span><span className="num">{claim.sightings.length}</span></h4>
          <ul className="rows">
            {claim.sightings.map((s, i) => (
              <li key={i} className="row">
                <span className="p">
                  {s.publisher ?? "unnamed source"} {s.synthetic && <span className="tag synthetic">synthetic</span>}
                </span>
                <span className="r">{fmtDate(s.date)}</span>
                {s.dateNote && <span className="why">{s.dateNote}</span>}
                {s.reportedBy && (
                  <a className="why" href={s.reportedBy} target="_blank" rel="noreferrer" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                    documented by fact-check <ArrowUpRight size={11} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
        {origins.length > 0 && (
          <div className="sect">
            <h4>Origin claims attached here</h4>
            <ul className="cautions">
              {origins.map((o) => (
                <li key={o.name} style={{ gridTemplateColumns: "1fr" }}>
                  <span><b style={{ fontWeight: 500, color: "var(--text)" }}>{o.name}</b> · confidence {o.confidence}{o.note ? `. ${o.note}` : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** True below 640px: the timeline turns vertical (oldest at the top). */
function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** Phone layout: the same family, as a vertical timeline, oldest first. */
function VerticalLineage({ view, selected, onSelect }: { view: LineageView; selected?: string; onSelect: (id: string) => void }) {
  const byId = new Map(view.claims.map((c) => [c.id, c]));
  const parentsOf = new Map<string, typeof view.edges>();
  for (const e of view.edges) parentsOf.set(e.child, [...(parentsOf.get(e.child) ?? []), e]);
  // How many generations sit above a claim, so a parent and child seen on the same day keep their order.
  const depth = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return Math.max(0, ...(parentsOf.get(id) ?? []).map((e) => 1 + depth(e.parent, new Set(seen))));
  };
  // Dated versions in date order; an undated version goes right after its parent.
  const dated = view.claims
    .filter((c) => c.firstSeen)
    .sort((a, b) => a.firstSeen!.localeCompare(b.firstSeen!) || depth(a.id) - depth(b.id));
  const undated = view.claims.filter((c) => !c.firstSeen);
  const claims: LineageClaim[] = [];
  for (const c of dated) {
    claims.push(c);
    for (const u of undated) if (parentsOf.get(u.id)?.some((e) => e.parent === c.id) && !claims.includes(u)) claims.push(u);
  }
  for (const u of undated) if (!claims.includes(u)) claims.push(u);
  const contested = new Set(view.origins.map((o) => o.name)).size > 1;

  return (
    <ol className="vline">
      {view.origins.length > 0 && (
        <li className="v-origin">
          <span className="k">{contested ? "origin contested" : "origin"}</span>
          {view.origins.map((o) => (
            <span key={o.name}>{o.name} <em className="num">{o.confidence}</em></span>
          ))}
        </li>
      )}
      {claims.map((c, i) => {
        const ups = parentsOf.get(c.id) ?? [];
        return (
          <li key={c.id} style={{ ["--d" as string]: `${i * 90}ms` }}>
            {ups.map((e) => {
              const p = byId.get(e.parent);
              const red = flows(c.status, p?.status ?? "unknown");
              const low = new Set(e.lowConfidenceTypes ?? []);
              return (
                <div key={e.parent} className={`v-edge ${red ? "red" : ""}`}>
                  <GitBranch size={12} /> from {fmtDate(p?.firstSeen ?? null)}
                  {(e.types ?? []).map((t) => (
                    <span key={t} className={`mut ${red ? "red" : ""} ${low.has(t) ? "low" : ""}`}>{SHORT[t] ?? t}{low.has(t) ? "?" : ""}</span>
                  ))}
                </div>
              );
            })}
            <button
              className={`g-node v-node s-${c.status} ${c.synthetic ? "synthetic" : ""} ${c.id === view.focusId ? "focus" : ""} ${c.id === selected ? "selected" : ""}`}
              onClick={() => onSelect(c.id)}
              aria-pressed={c.id === selected}
            >
              <span className="top">
                <span>{fmtDate(c.firstSeen)}</span>
                {c.synthetic && <span className="tag synthetic">synthetic</span>}
              </span>
              <span className="txt">{c.text}</span>
              <span className="foot"><span className="state"><i />{STATUS_TEXT[c.status](c)}</span></span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

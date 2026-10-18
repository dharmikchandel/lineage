// Write-back: every node and edge Lineage creates goes through here.
// All writes use MERGE on the node key so re-running a seed or an analysis never duplicates.
// Every edge an agent creates carries provenance: asserted_by, at, confidence.

import { randomUUID } from "node:crypto";
import { read, run } from "@/lib/db";
import type { DebunkBasis, FactCheckVerdict, MutationType, PublisherKind } from "@/domain/types";

export interface ClaimInput {
  id: string;
  text: string;
  firstSeen: string | null; // ISO date, possibly partial ("2014-10")
  attributedTo?: string | null;
  synthetic: boolean;
  embedding?: number[] | null;
}

/** Create or update a Claim. The embedding is stored as a FalkorDB vector (vecf32). */
export async function upsertClaim(c: ClaimInput): Promise<void> {
  await run(
    `MERGE (c:Claim {id: $id})
     SET c.text = $text, c.first_seen = $firstSeen, c.attributed_to = $attributedTo, c.synthetic = $synthetic
     WITH c
     // Only overwrite the embedding when we have one; never null out an existing vector.
     WHERE $embedding IS NOT NULL
     SET c.embedding = vecf32($embedding)`,
    { id: c.id, text: c.text, firstSeen: c.firstSeen, attributedTo: c.attributedTo ?? null, synthetic: c.synthetic, embedding: c.embedding ?? null },
  );
}

export async function upsertPublisher(p: { name: string; url: string | null; kind: PublisherKind; synthetic: boolean }) {
  await run(`MERGE (p:Publisher {name: $name}) SET p.url = $url, p.kind = $kind, p.synthetic = $synthetic`, p);
}

export async function upsertSource(s: { name: string; url: string | null; kind: string }) {
  await run(`MERGE (s:Source {name: $name}) SET s.url = $url, s.kind = $kind`, s);
}

/** One appearance of a claim in the world: (Sighting)-[:SIGHTING_OF]->(Claim), (Sighting)-[:PUBLISHED_BY]->(Publisher). */
export async function addSighting(s: {
  id: string;
  claimId: string;
  publisher: string | null;
  url: string | null;
  date: string | null;
  dateNote?: string | null;
  snippet: string;
  synthetic: boolean;
  reportedBy?: string | null; // fact-check URL that documents this sighting
}) {
  await run(
    `MATCH (c:Claim {id: $claimId})
     MERGE (s:Sighting {id: $id})
     SET s.url = $url, s.date = $date, s.date_note = $dateNote, s.snippet = $snippet,
         s.synthetic = $synthetic, s.reported_by = $reportedBy
     MERGE (s)-[:SIGHTING_OF]->(c)
     WITH s
     OPTIONAL MATCH (p:Publisher {name: $publisher})
     FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END | MERGE (s)-[:PUBLISHED_BY]->(p))`,
    { ...s, dateNote: s.dateNote ?? null, reportedBy: s.reportedBy ?? null },
  );
}

export class CycleError extends Error {}

/**
 * Link child -[:MUTATED_FROM]-> parent, keeping the lineage a DAG.
 *
 * Rules (section 3): a child links only to a parent with an earlier-or-equal
 * known date; if a date is unknown the edge is marked direction_certain=false;
 * and the edge is refused if it would close a cycle.
 */
export async function linkMutation(e: {
  childId: string;
  parentId: string;
  types: MutationType[];
  beforeText: string;
  afterText: string;
  confidence: number;
  /** Types on this edge that are best-effort guesses (shown with a lower-confidence label). */
  lowConfidenceTypes?: MutationType[];
  assertedBy: string;
  note?: string | null;
}): Promise<{ directionCertain: boolean }> {
  if (e.childId === e.parentId) throw new CycleError("A claim cannot mutate from itself.");

  const [dates] = await read<{ child: string | null; parent: string | null; wouldCycle: boolean }>(
    `MATCH (child:Claim {id: $childId}), (parent:Claim {id: $parentId})
     // Is the child already an ancestor of the parent? Then child->parent would close a loop.
     OPTIONAL MATCH loop = (parent)-[:MUTATED_FROM*1..]->(child)
     RETURN child.first_seen AS child, parent.first_seen AS parent, loop IS NOT NULL AS wouldCycle
     LIMIT 1`,
    { childId: e.childId, parentId: e.parentId },
  );
  if (!dates) throw new Error(`Cannot link ${e.childId} -> ${e.parentId}: claim not found.`);
  if (dates.wouldCycle) throw new CycleError(`Linking ${e.childId} -> ${e.parentId} would create a cycle.`);

  let directionCertain = true;
  if (dates.child == null || dates.parent == null) {
    directionCertain = false;
  } else if (comparePartialDates(dates.parent, dates.child) > 0) {
    throw new CycleError(
      `Parent ${e.parentId} (${dates.parent}) is newer than child ${e.childId} (${dates.child}); refusing a backwards edge.`,
    );
  }

  await run(
    `MATCH (child:Claim {id: $childId}), (parent:Claim {id: $parentId})
     MERGE (child)-[r:MUTATED_FROM]->(parent)
     SET r.types = $types, r.before_text = $beforeText, r.after_text = $afterText,
         r.confidence = $confidence, r.asserted_by = $assertedBy, r.at = $at,
         r.direction_certain = $directionCertain, r.low_confidence_types = $lowConfidenceTypes, r.note = $note`,
    { ...e, note: e.note ?? null, lowConfidenceTypes: e.lowConfidenceTypes ?? [], at: new Date().toISOString(), directionCertain },
  );
  return { directionCertain };
}

/**
 * Compare ISO dates that may be partial ("2014", "2014-10", "2014-10-27").
 * Only the shared precision is compared, so "2014-10" vs "2014-10-27" counts as equal.
 */
export function comparePartialDates(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  return a.slice(0, n).localeCompare(b.slice(0, n));
}

/** (Claim)-[:ORIGINATES_FROM]->(Source|Publisher). Several per claim means a contested origin. */
export async function addOrigin(o: {
  claimId: string;
  targetLabel: "Source" | "Publisher";
  targetName: string;
  confidence: number;
  evidenceUrl: string;
  established: boolean; // true = a fact-checker established this as the TRUE source
  assertedBy: string;
  note?: string | null;
}) {
  await run(
    `MATCH (c:Claim {id: $claimId}), (t:${o.targetLabel} {name: $targetName})
     MERGE (c)-[r:ORIGINATES_FROM]->(t)
     SET r.confidence = $confidence, r.evidence_url = $evidenceUrl, r.established = $established,
         r.asserted_by = $assertedBy, r.at = $at, r.note = $note`,
    { ...o, note: o.note ?? null, at: new Date().toISOString() },
  );
}

/** (Claim)-[:CHECKED_BY {verdict, basis}]->(FactCheck). Every FactCheck has a real URL. */
export async function addFactCheck(f: {
  claimId: string;
  url: string;
  publisher: string;
  date: string | null;
  verdict: FactCheckVerdict;
  basis: DebunkBasis | null;
  summary: string;
  assertedBy: string;
}) {
  await run(
    `MATCH (c:Claim {id: $claimId})
     MERGE (f:FactCheck {url: $url})
     SET f.publisher = $publisher, f.date = $date, f.verdict = $verdict, f.basis = $basis, f.summary = $summary
     MERGE (c)-[r:CHECKED_BY]->(f)
     SET r.verdict = $verdict, r.basis = $basis, r.asserted_by = $assertedBy, r.at = $at`,
    { ...f, at: new Date().toISOString() },
  );
}

// ---------------------------------------------------------------------------
// Agent trace: AgentRun -[:FOUND]-> Finding -[:ABOUT]-> Claim
// Agents never call each other. Each one writes its Findings here, and the next
// agent reads them back from the graph (see src/agents/trace.ts).
// ---------------------------------------------------------------------------

export async function startAgentRun(r: {
  analysisId: string;
  agent: string;
  seq: number;
  method: "llm" | "rule-based";
  mode: "live" | "recorded";
}): Promise<string> {
  const id = randomUUID();
  await run(
    `CREATE (a:AgentRun {id: $id, analysis_id: $analysisId, agent: $agent, seq: $seq, method: $method,
                         mode: $mode, status: 'running', started_at: $at})`,
    { id, ...r, at: new Date().toISOString() },
  );
  return id;
}

export async function finishAgentRun(
  id: string,
  r: { status: "ok" | "error"; provider?: string | null; model?: string | null; cached?: boolean; error?: string | null },
) {
  await run(
    `MATCH (a:AgentRun {id: $id})
     SET a.status = $status, a.provider = $provider, a.model = $model, a.cached = $cached,
         a.error = $error, a.finished_at = $at`,
    { id, status: r.status, provider: r.provider ?? null, model: r.model ?? null, cached: r.cached ?? false, error: r.error ?? null, at: new Date().toISOString() },
  );
}

export async function addFinding(f: {
  runId: string;
  kind: string;
  summary: string;
  data: unknown;
  aboutClaimIds?: string[];
}): Promise<string> {
  const id = randomUUID();
  await run(
    `MATCH (a:AgentRun {id: $runId})
     CREATE (a)-[:FOUND]->(f:Finding {id: $id, kind: $kind, summary: $summary, data: $data, at: $at})
     WITH f
     UNWIND $about AS cid
     MATCH (c:Claim {id: cid})
     MERGE (f)-[:ABOUT]->(c)`,
    { id, runId: f.runId, kind: f.kind, summary: f.summary, data: JSON.stringify(f.data), about: f.aboutClaimIds ?? [], at: new Date().toISOString() },
  );
  return id;
}

/** Remove one analysis's trace (used before re-running a recorded run that stopped half way). */
export async function clearAnalysis(analysisId: string) {
  await run(`MATCH (:AgentRun {analysis_id: $analysisId})-[:FOUND]->(f:Finding) DETACH DELETE f`, { analysisId });
  await run(`MATCH (a:AgentRun {analysis_id: $analysisId}) DETACH DELETE a`, { analysisId });
}

// The Cypher queries the product depends on (section 7 of the brief).
// Each one is named (Q1-Q6), commented in plain English, and documented in the README.
// All reads go through GRAPH.RO_QUERY. Every query runs live against FalkorDB.

import { read } from "@/lib/db";
import { config } from "@/lib/config";
import type { InheritancePath } from "@/domain/propagation";

// ---------------------------------------------------------------------------
// Q1 Candidate retrieval
// ---------------------------------------------------------------------------
export const Q1_CANDIDATES = `
// Ask the vector index for the k claims whose meaning is closest to the new claim.
CALL db.idx.vector.queryNodes('Claim', 'embedding', $k, vecf32($embedding)) YIELD node, score
WITH node AS c, score
// Attach whatever fact-checks already cover each candidate, so the Linker sees
// "this one was debunked as fabricated" alongside the text.
OPTIONAL MATCH (c)-[chk:CHECKED_BY]->(f:FactCheck)
RETURN c.id AS id,
       c.text AS text,
       c.first_seen AS firstSeen,
       c.attributed_to AS attributedTo,
       c.synthetic AS synthetic,
       // Recompute cosine similarity explicitly (1 = same meaning) so we never
       // depend on whether the index reports a distance or a similarity.
       1 - vec.cosineDistance(c.embedding, vecf32($embedding)) AS similarity,
       collect(CASE WHEN f IS NULL THEN NULL ELSE {verdict: chk.verdict, basis: chk.basis, publisher: f.publisher, url: f.url} END) AS checks
ORDER BY similarity DESC
`;

export interface Candidate {
  id: string;
  text: string;
  firstSeen: string | null;
  attributedTo: string | null;
  synthetic: boolean;
  similarity: number;
  checks: { verdict: string; basis: string | null; publisher: string; url: string }[];
}

export async function q1Candidates(embedding: number[], k = 5): Promise<Candidate[]> {
  return read<Candidate>(Q1_CANDIDATES, { embedding, k });
}

// ---------------------------------------------------------------------------
// Q2 Origin tracing
// ---------------------------------------------------------------------------
export const Q2_ORIGINS = `
// Start at the claim and follow MUTATED_FROM upward (child -> parent) as far as it goes.
MATCH (c:Claim {id: $id})
MATCH path = (c)-[:MUTATED_FROM*0..${Math.trunc(config.propagation.maxDepth) + 4}]->(root:Claim)
// A root is a claim with no parent of its own: the oldest version we know.
WHERE NOT (root)-[:MUTATED_FROM]->(:Claim)
// Fact-checkers attach an origin wherever they believe the story started, which is
// not always the oldest claim we hold. So collect ORIGINATES_FROM edges from every
// claim on the path. More than one distinct origin means the origin is contested.
UNWIND nodes(path) AS n
OPTIONAL MATCH (n)-[o:ORIGINATES_FROM]->(src)
WITH path, root, collect(CASE WHEN src IS NULL THEN NULL ELSE {
       name: src.name, url: src.url, kind: src.kind, label: labels(src)[0], claimId: n.id,
       confidence: o.confidence, evidenceUrl: o.evidence_url, established: o.established, note: o.note
     } END) AS origins
RETURN root.id AS rootId,
       root.text AS rootText,
       root.first_seen AS rootFirstSeen,
       [x IN nodes(path) | {id: x.id, text: x.text, firstSeen: x.first_seen}] AS chain,
       [r IN relationships(path) | {types: r.types, confidence: r.confidence, directionCertain: r.direction_certain, note: r.note}] AS hops,
       origins
`;

export interface OriginRow {
  rootId: string;
  rootText: string;
  rootFirstSeen: string | null;
  chain: { id: string; text: string; firstSeen: string | null }[];
  hops: { types: string[]; confidence: number; directionCertain: boolean; note: string | null }[];
  origins: {
    claimId: string;
    name: string;
    url: string;
    kind: string;
    label: string;
    confidence: number;
    evidenceUrl: string;
    established: boolean | null;
    note: string | null;
  }[];
}

export async function q2Origins(id: string): Promise<{ rows: OriginRow[]; contested: boolean }> {
  const rows = await read<OriginRow>(Q2_ORIGINS, { id });
  const distinct = new Set(rows.flatMap((r) => r.origins.map((o) => o.name)));
  return { rows, contested: distinct.size > 1 };
}

// ---------------------------------------------------------------------------
// Q3 Descendants / spread
// ---------------------------------------------------------------------------
export const Q3_DESCENDANTS = `
// Follow MUTATED_FROM downward: every claim that (directly or indirectly) mutated from this one.
MATCH (c:Claim {id: $id})<-[:MUTATED_FROM*1..${Math.trunc(config.propagation.maxDepth) + 4}]-(d:Claim)
WITH DISTINCT d
// Who posted each variant, and when.
OPTIONAL MATCH (s:Sighting)-[:SIGHTING_OF]->(d)
OPTIONAL MATCH (s)-[:PUBLISHED_BY]->(p:Publisher)
RETURN d.id AS id, d.text AS text, d.first_seen AS firstSeen, d.synthetic AS synthetic,
       collect(DISTINCT CASE WHEN p IS NULL THEN NULL ELSE {publisher: p.name, date: s.date, url: s.url} END) AS sightings
ORDER BY firstSeen
`;

export async function q3Descendants(id: string) {
  return read<{ id: string; text: string; firstSeen: string | null; synthetic: boolean; sightings: { publisher: string; date: string; url: string }[] }>(
    Q3_DESCENDANTS,
    { id },
  );
}

// ---------------------------------------------------------------------------
// Q4 Inherited verdict (the traversal half; the rule half is src/domain/propagation.ts)
// ---------------------------------------------------------------------------
export const Q4_INHERITANCE_PATHS = `
// Walk UP from the claim along MUTATED_FROM, zero or more hops (zero = the claim
// itself was fact-checked), to any ancestor that has a fact-check.
MATCH path = (c:Claim {id: $id})-[:MUTATED_FROM*0..${Math.trunc(config.propagation.maxDepth)}]->(a:Claim)-[chk:CHECKED_BY]->(f:FactCheck)
// The true origin(s) the fact-checker established for that ancestor (needed to
// recognise a re-attribution to the true author as a correction).
OPTIONAL MATCH (a)-[o:ORIGINATES_FROM {established: true}]->(src)
WITH path, chk, f, collect(src.name) AS establishedSources
RETURN [n IN nodes(path) | {id: n.id, text: n.text, attributedTo: n.attributed_to}] AS claims,
       [r IN relationships(path) | {
          types: r.types, beforeText: r.before_text, afterText: r.after_text,
          confidence: r.confidence, directionCertain: r.direction_certain
       }] AS hops,
       {url: f.url, publisher: f.publisher, date: f.date, verdict: chk.verdict, basis: chk.basis} AS factCheck,
       establishedSources,
       // Per-hop decay computed in the graph, for display; the rule code recomputes it
       // while checking the basis hop by hop.
       reduce(conf = 1.0, r IN relationships(path) | conf * $decay * r.confidence) AS decayedConfidence
ORDER BY size(relationships(path))
`;

export async function q4InheritancePaths(id: string): Promise<InheritancePath[]> {
  const rows = await read<InheritancePath & { decayedConfidence: number }>(Q4_INHERITANCE_PATHS, {
    id,
    decay: config.propagation.decay,
  });
  return rows.map(({ decayedConfidence: _unused, ...p }) => p);
}

// ---------------------------------------------------------------------------
// Q5 Story families (graph algorithm: weakly connected components)
// ---------------------------------------------------------------------------
export const Q5_FAMILIES = `
// Treat MUTATED_FROM as undirected and find connected groups of claims: each
// group is one "story" told many ways.
CALL algo.WCC({nodeLabels: ['Claim'], relationshipTypes: ['MUTATED_FROM']}) YIELD node, componentId
WITH componentId, collect(node) AS members
WHERE size(members) > 1
UNWIND members AS m
WITH componentId, members, m ORDER BY m.first_seen
RETURN componentId,
       size(members) AS variants,
       min(m.first_seen) AS firstSeen,
       max(m.first_seen) AS lastSeen,
       collect(m.id) AS claimIds
ORDER BY variants DESC
`;

export async function q5Families() {
  return read<{ componentId: number; variants: number; firstSeen: string; lastSeen: string; claimIds: string[] }>(Q5_FAMILIES);
}

/** The family that contains one claim: "N variants, M years". */
export async function q5FamilyOf(id: string) {
  const fams = await q5Families();
  return fams.find((f) => f.claimIds.includes(id)) ?? null;
}

// ---------------------------------------------------------------------------
// Q6 Publisher spread
// ---------------------------------------------------------------------------
export const Q6_PUBLISHER_SPREAD = `
// For every claim in the given family, list who posted it and when.
MATCH (s:Sighting)-[:SIGHTING_OF]->(c:Claim)
WHERE c.id IN $claimIds
MATCH (s)-[:PUBLISHED_BY]->(p:Publisher)
RETURN p.name AS publisher, p.kind AS kind, p.url AS publisherUrl, p.synthetic AS synthetic,
       collect({claimId: c.id, date: s.date, url: s.url, dateNote: s.date_note}) AS posts,
       min(s.date) AS firstPost
ORDER BY firstPost
`;

export async function q6PublisherSpread(claimIds: string[]) {
  return read<{
    publisher: string;
    kind: string;
    publisherUrl: string | null;
    synthetic: boolean;
    posts: { claimId: string; date: string; url: string; dateNote: string | null }[];
    firstPost: string;
  }>(Q6_PUBLISHER_SPREAD, { claimIds });
}

// ---------------------------------------------------------------------------
// Health: is the graph empty? (The cloud DB is disposable and may come back blank.)
// ---------------------------------------------------------------------------
export async function graphCounts() {
  const rows = await read<{ claims: number; factChecks: number; withEmbedding: number }>(
    `MATCH (c:Claim)
     OPTIONAL MATCH (c)-[:CHECKED_BY]->(f:FactCheck)
     RETURN count(DISTINCT c) AS claims, count(DISTINCT f) AS factChecks,
            count(DISTINCT CASE WHEN c.embedding IS NOT NULL THEN c END) AS withEmbedding`,
  );
  return rows[0] ?? { claims: 0, factChecks: 0, withEmbedding: 0 };
}

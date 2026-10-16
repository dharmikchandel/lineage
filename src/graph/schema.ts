// Graph schema: indexes and uniqueness constraints. Idempotent; safe to run repeatedly.
//
// FalkorDB is schema-optional, so the "schema" is really: which lookups must be
// fast (indexes), which ids must be unique (constraints), and the vector index
// that powers Q1 candidate retrieval.

import { getGraph, read, run } from "@/lib/db";
import { config } from "@/lib/config";

/** Every node label and the property that identifies it. */
export const NODE_KEYS = {
  Claim: "id",
  Sighting: "id",
  Publisher: "name",
  Source: "name",
  FactCheck: "url",
  AgentRun: "id",
  Finding: "id",
} as const;

function alreadyExists(err: unknown): boolean {
  return /already (exists|indexed)|already exist/i.test(err instanceof Error ? err.message : String(err));
}

export async function ensureSchema(log: (m: string) => void = console.log): Promise<void> {
  const graph = await getGraph();

  for (const [label, key] of Object.entries(NODE_KEYS)) {
    // Exact-match (range) index: makes MERGE / MATCH on the key fast.
    try {
      await run(`CREATE INDEX FOR (n:${label}) ON (n.${key})`);
      log(`index    :${label}(${key}) created`);
    } catch (err) {
      if (!alreadyExists(err)) throw err;
      log(`index    :${label}(${key}) exists`);
    }
    // Uniqueness constraint (FalkorDB requires the index above to exist first).
    try {
      await graph.constraintCreate("UNIQUE" as never, "NODE" as never, label, key);
      log(`unique   :${label}(${key}) created`);
    } catch (err) {
      if (!alreadyExists(err)) throw err;
      log(`unique   :${label}(${key}) exists`);
    }
  }

  // Dates are compared when walking lineage and ordering spread (Q3, Q6).
  for (const [label, prop] of [["Claim", "first_seen"], ["Sighting", "date"]] as const) {
    try {
      await run(`CREATE INDEX FOR (n:${label}) ON (n.${prop})`);
      log(`index    :${label}(${prop}) created`);
    } catch (err) {
      if (!alreadyExists(err)) throw err;
    }
  }

  // Vector index over claim embeddings, used by Q1. Cosine similarity; the
  // dimension is fixed at creation and must equal EMBEDDING_DIM.
  try {
    await run(
      `CREATE VECTOR INDEX FOR (c:Claim) ON (c.embedding)
       OPTIONS {dimension: ${Math.trunc(config.embedding.dim)}, similarityFunction: 'cosine'}`,
    );
    log(`vector   :Claim(embedding) dim=${config.embedding.dim} cosine created`);
  } catch (err) {
    if (!alreadyExists(err)) throw err;
    log(`vector   :Claim(embedding) exists`);
  }
}

/** Returns the dimension of the Claim.embedding vector index, or null if it does not exist. */
export async function vectorIndexDimension(): Promise<number | null> {
  const rows = await read<{ label: string; properties: string[]; types: unknown; options: unknown }>(
    `CALL db.indexes() YIELD label, properties, types, options
     WHERE label = 'Claim'
     RETURN label, properties, types, options`,
  );
  for (const r of rows) {
    // `types` maps each property to its index kinds, e.g. {embedding: ['VECTOR']};
    // `options` maps each property to its settings. Shapes vary by version, so read defensively.
    const opts = JSON.stringify(r.options ?? {});
    const types = JSON.stringify(r.types ?? {});
    if (!/embedding/.test(types + JSON.stringify(r.properties)) || !/VECTOR/i.test(types)) continue;
    const m = opts.match(/"?dimension"?\s*[:=]\s*(\d+)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

// pnpm seed            -> load every story file in data/seed/ into FalkorDB (idempotent, NO API calls).
//                            Uses precomputed vectors from data/seed/embeddings.json when they match.
// pnpm seed --embed -> Gate 1 only: compute missing seed embeddings (asks first, prints an estimate),
//                            then save them to data/seed/embeddings.json so reseeding is free.
// pnpm seed --reset -> delete the graph first (asks first).
// In recorded mode (LINEAGE_MODE=recorded) `pnpm seed` also replays the recorded preset runs
// from data/recorded/ (still NO API calls), so one command makes a deployment ready.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { createHash } from "node:crypto";
import { config } from "@/lib/config";
import { closeGraph, getGraph } from "@/lib/db";
import { ensureSchema } from "@/graph/schema";
import { graphCounts } from "@/graph/queries";
import { addFactCheck, addOrigin, addSighting, linkMutation, upsertClaim, upsertPublisher, upsertSource } from "@/graph/writes";
import type { DebunkBasis, FactCheckVerdict, MutationType, PublisherKind } from "@/domain/types";
import { RunBudget } from "@/llm/budget";
import { embed } from "@/llm/embed";
import { readManifest, replayPresets } from "@/recorded";

const SEED_DIR = path.join(process.cwd(), "data", "seed");
const EMBEDDINGS_FILE = path.join(SEED_DIR, "embeddings.json");

interface StoryFile {
  story: string;
  publishers: { name: string; url: string | null; kind: PublisherKind }[];
  sources: { name: string; url: string | null; kind: string }[];
  claims: { id: string; text: string; first_seen: string | null; attributed_to: string | null; synthetic?: boolean }[];
  sightings: {
    id: string;
    claim: string;
    publisher: string | null;
    url: string | null;
    date: string | null;
    date_note: string | null;
    snippet: string;
    reported_by: string | null;
    synthetic?: boolean;
  }[];
  mutations: {
    child: string;
    parent: string;
    types: MutationType[];
    before_text: string;
    after_text: string;
    confidence: number;
    note: string | null;
  }[];
  origins: {
    claim: string;
    target_label: "Source" | "Publisher";
    target: string;
    confidence: number;
    established: boolean;
    evidence_url: string;
    note: string | null;
  }[];
  fact_checks: {
    claim: string;
    url: string;
    publisher: string;
    date: string | null;
    verdict: FactCheckVerdict;
    basis: DebunkBasis | null;
    summary: string;
  }[];
}

interface EmbeddingsFile {
  model: string;
  dim: number;
  vectors: Record<string, { textHash: string; vector: number[] }>;
}

const textHash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);

async function ask(q: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} Type 'yes': `)).trim();
  rl.close();
  return a === "yes";
}

async function loadEmbeddings(): Promise<EmbeddingsFile> {
  const empty = { model: config.embedding.model, dim: config.embedding.dim, vectors: {} };
  try {
    const f = JSON.parse(await readFile(EMBEDDINGS_FILE, "utf8")) as EmbeddingsFile;
    if (f.model !== config.embedding.model || f.dim !== config.embedding.dim) {
      console.warn(`embeddings.json was made with ${f.model}/${f.dim}, config is ${config.embedding.model}/${config.embedding.dim}: ignoring it.`);
      return empty;
    }
    return f;
  } catch {
    return empty;
  }
}

async function main() {
  const doEmbed = process.argv.includes("--embed");
  const doReset = process.argv.includes("--reset");

  const files = (await readdir(SEED_DIR)).filter((f) => f.endsWith(".json") && f !== "embeddings.json").sort();
  const stories: StoryFile[] = [];
  for (const f of files) stories.push(JSON.parse(await readFile(path.join(SEED_DIR, f), "utf8")));

  const embeddings = await loadEmbeddings();
  const allClaims = stories.flatMap((s) => s.claims);
  const missing = allClaims.filter((c) => embeddings.vectors[c.id]?.textHash !== textHash(c.text));

  if (doEmbed && missing.length > 0) {
    console.log(`Gate 1: will make up to ${missing.length} embedding call(s) with ${config.embedding.model} (~${missing.reduce((s, c) => s + Math.ceil(c.text.length / 4), 0)} input tokens). No LLM calls.`);
    if (!(await ask("Proceed?"))) return;
    const budget = new RunBudget();
    for (const c of missing) {
      const { vector, cached } = await embed(c.text, budget);
      embeddings.vectors[c.id] = { textHash: textHash(c.text), vector: vector.map((x) => Math.round(x * 1e6) / 1e6) };
      console.log(`  embedded ${c.id}${cached ? " (cache)" : ""}`);
    }
    await writeFile(EMBEDDINGS_FILE, JSON.stringify(embeddings));
    console.log(`saved ${EMBEDDINGS_FILE} (commit it so reseeding costs nothing)`);
  }

  if (doReset) {
    if (!(await ask(`Delete graph "${config.falkor.graph}" and reload from seed files?`))) return;
    const g = await getGraph();
    await g.delete().catch(() => {});
  }

  await ensureSchema(() => {});

  for (const s of stories) {
    console.log(`seeding: ${s.story}`);
    for (const p of s.publishers) await upsertPublisher({ ...p, synthetic: false });
    for (const src of s.sources) await upsertSource(src);
    for (const c of s.claims) {
      const e = embeddings.vectors[c.id];
      await upsertClaim({
        id: c.id,
        text: c.text,
        firstSeen: c.first_seen,
        attributedTo: c.attributed_to,
        synthetic: c.synthetic ?? false,
        embedding: e && e.textHash === textHash(c.text) ? e.vector : null,
      });
    }
    for (const si of s.sightings) {
      await addSighting({
        id: si.id,
        claimId: si.claim,
        publisher: si.publisher,
        url: si.url,
        date: si.date,
        dateNote: si.date_note,
        snippet: si.snippet,
        synthetic: si.synthetic ?? false,
        reportedBy: si.reported_by,
      });
    }
    for (const m of s.mutations) {
      await linkMutation({
        childId: m.child,
        parentId: m.parent,
        types: m.types,
        beforeText: m.before_text,
        afterText: m.after_text,
        confidence: m.confidence,
        assertedBy: "seed (from cited fact-checks)",
        note: m.note,
      });
    }
    for (const o of s.origins) {
      await addOrigin({
        claimId: o.claim,
        targetLabel: o.target_label,
        targetName: o.target,
        confidence: o.confidence,
        evidenceUrl: o.evidence_url,
        established: o.established,
        assertedBy: "seed (from cited fact-checks)",
        note: o.note,
      });
    }
    for (const f of s.fact_checks) {
      await addFactCheck({ claimId: f.claim, url: f.url, publisher: f.publisher, date: f.date, verdict: f.verdict, basis: f.basis, summary: f.summary, assertedBy: "seed" });
    }
  }

  const counts = await graphCounts();
  console.log(`done: ${counts.claims} claims, ${counts.factChecks} fact-checks, ${counts.withEmbedding} with embeddings`);
  if (config.mode === "recorded") {
    const manifest = await readManifest();
    if (!manifest) throw new Error("Recorded mode needs data/recorded/manifest.json (made by pnpm record).");
    console.log(`loading recorded runs (${manifest.model}, ${manifest.recordedOn}):`);
    await replayPresets(manifest, console.log);
  }
  const stillMissing = allClaims.filter((c) => embeddings.vectors[c.id]?.textHash !== textHash(c.text));
  if (stillMissing.length) {
    console.log(`NOTE: ${stillMissing.length} seed claim(s) have no embedding, so Q1 cannot find them yet. After Gate 1: pnpm seed --embed`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeGraph);

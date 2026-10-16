// pnpm analyze --go [--synthetic] "claim text"
//
// Runs the Extractor and Linker against the live graph (Gates 1 + 2: makes real API calls,
// at most 2 LLM calls + 1 embedding call per atomic claim), then prints Q2 and Q4 for each result.
// --go is required so the pipeline is never started by accident.
// --synthetic marks the stored claim and sighting as synthetic demo data.

import { randomUUID } from "node:crypto";
import { config, requiredVariables } from "@/lib/config";
import { closeGraph } from "@/lib/db";
import { graphCounts, q2Origins, q4InheritancePaths } from "@/graph/queries";
import { deriveVerdict } from "@/domain/propagation";
import { RunBudget } from "@/llm/budget";
import { runExtractor } from "@/agents/extractor";
import { runLinker } from "@/agents/linker";
import { readTrace } from "@/agents/trace";

async function main() {
  const args = process.argv.slice(2);
  const go = args.includes("--go");
  const synthetic = args.includes("--synthetic");
  const text = args.filter((a) => !a.startsWith("--")).join(" ").trim();

  if (!text) throw new Error('Usage: pnpm analyze --go [--synthetic] "claim text"');
  if (!go) throw new Error("Refusing to call external APIs without --go (the owner must clear Gates 1 and 2 first).");
  const missing = requiredVariables().filter((v) => !v.present).map((v) => v.name);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}. Run pnpm preflight.`);
  if ((await graphCounts()).claims === 0) throw new Error("The graph is empty. Run pnpm schema && pnpm seed.");

  const analysisId = randomUUID();
  const budget = new RunBudget();
  console.log(`analysis ${analysisId} (budget: ${config.budget.maxCallsPerRun} LLM calls this run)\n`);

  const claims = await runExtractor(analysisId, text, budget);
  console.log(`Extractor: ${claims.length} atomic claim(s)`);
  for (const c of claims) console.log(`  - ${c.text}`);

  const today = new Date().toISOString().slice(0, 10);
  const outcomes = await runLinker(analysisId, budget, { synthetic, sightingDate: today });

  console.log("\nAgent trace (read back from the graph):");
  for (const r of await readTrace(analysisId)) {
    console.log(`  [${r.seq}] ${r.agent} (${r.method}) ${r.status} via ${r.provider ?? "-"}${r.cached ? " [cache]" : ""}`);
    for (const f of r.findings) console.log(`        ${f.kind}: ${f.summary}`);
  }

  for (const o of outcomes) {
    console.log(`\n== ${o.text}\n   claim ${o.claimId} (${o.status})`);
    const origins = await q2Origins(o.claimId);
    console.log(`   Q2 origin${origins.contested ? " (CONTESTED)" : ""}:`);
    for (const row of origins.rows) {
      console.log(`     chain: ${row.chain.map((c) => `${c.id}[${c.firstSeen ?? "?"}]`).join(" -> ")}`);
      for (const og of row.origins) console.log(`     origin: ${og.name} (conf ${og.confidence}) ${og.evidenceUrl}`);
    }
    const verdict = deriveVerdict(await q4InheritancePaths(o.claimId), config.propagation);
    console.log(`   Q4 derived verdict: ${verdict.kind}`);
    if (verdict.kind === "inherited") {
      const b = verdict.best;
      console.log(`     ${b.verdict} (basis ${b.basis}), confidence ${b.confidence.toFixed(2)} over ${b.hopCount} hop(s)`);
      console.log(`     ${b.explanation}`);
      console.log(`     fact-check: ${b.path.factCheck.publisher} ${b.path.factCheck.url}`);
    } else if (verdict.kind === "unknown") {
      console.log("     No match in the graph. Unknown.");
    } else {
      for (const a of verdict.all) console.log(`     ${a.status}: ${a.explanation}`);
    }
  }
  console.log(`\nLLM calls this run: ${budget.llmCalls}, embedding calls: ${budget.embedCalls}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeGraph);

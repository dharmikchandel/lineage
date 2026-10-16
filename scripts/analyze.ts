// pnpm analyze --go [--synthetic] "claim text"
//
// Runs all four agents against the live graph (Gates 1 + 2: real API calls).
// Cost per run: 1 embedding call per atomic claim, plus at most 3 LLM calls
// (Extractor, one batched Linker call, one batched Writer call). Cached inputs cost 0.
// --go is required so the pipeline is never started by accident.
// --synthetic marks the stored claim and sighting as synthetic demo data.

import { requiredVariables } from "@/lib/config";
import { closeGraph } from "@/lib/db";
import { readTrace } from "@/agents/trace";
import { runAnalysis } from "@/pipeline";

async function main() {
  const args = process.argv.slice(2);
  const go = args.includes("--go");
  const synthetic = args.includes("--synthetic");
  const text = args.filter((a) => !a.startsWith("--")).join(" ").trim();

  if (!text) throw new Error('Usage: pnpm analyze --go [--synthetic] "claim text"');
  if (!go) throw new Error("Refusing to call external APIs without --go (the owner must clear Gates 1 and 2 first).");
  const missing = requiredVariables().filter((v) => !v.present).map((v) => v.name);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}. Run pnpm preflight.`);

  const result = await runAnalysis(text, { synthetic });

  console.log(`analysis ${result.analysisId}\n\nAgent trace (read back from the graph):`);
  for (const r of await readTrace(result.analysisId)) {
    console.log(`  [${r.seq}] ${r.agent} (${r.method}) ${r.status} via ${r.provider ?? "-"}${r.cached ? " [cache]" : ""}`);
    for (const f of r.findings) console.log(`        ${f.kind}: ${f.summary}`);
  }

  for (const a of result.answers) {
    console.log(`\n== ${a.text}${a.synthetic ? "  [SYNTHETIC DEMO DATA]" : ""}`);
    console.log(`   ${a.headline}`);
    console.log(`   ${a.summary}  (written by: ${a.writtenBy})`);
    if (a.kind === "inherited") {
      console.log(`   verdict: ${a.verdict}, basis: ${a.basis}, confidence ${a.confidence.toFixed(2)} (raw ${a.rawConfidence.toFixed(2)}), ${a.hops} hop(s)`);
      for (const s of a.supporting) console.log(`   fact-check: ${s.publisher} (${s.hops} hop(s) up) ${s.url}`);
    }
    if (a.chain.length > 1) console.log(`   lineage: ${a.chain.map((c) => `${c.id}[${c.firstSeen ?? "?"}]`).join(" -> ")}`);
    console.log(`   origin${a.origins.contested ? " (CONTESTED)" : ""}: ${a.origins.list.map((o) => `${o.name} (${o.confidence})`).join("; ") || "none recorded"}`);
    for (const c of a.cautions) console.log(`   caution: ${c}`);
    console.log(`   what the graph did: ${a.whatTheGraphDid}`);
  }
  console.log(`\nLLM calls this run: ${result.llmCalls}, embedding calls: ${result.embedCalls}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeGraph);

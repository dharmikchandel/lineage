// pnpm preflight              -> config names, .env gitignored, FalkorDB reachable, vector index dimension
// pnpm preflight --check-keys -> also ONE tiny LLM call and ONE embedding call (asks first)
//
// Never prints secret values, only variable NAMES and present/missing.

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { config, requiredVariables } from "@/lib/config";
import { closeGraph } from "@/lib/db";
import { vectorIndexDimension } from "@/graph/schema";
import { graphCounts } from "@/graph/queries";
import { RunBudget, todaysUsage } from "@/llm/budget";
import { generateJson } from "@/llm/llm";
import { embed } from "@/llm/embed";

const ok = (m: string) => console.log(`  ok       ${m}`);
const bad = (m: string) => console.log(`  MISSING  ${m}`);
const warn = (m: string) => console.log(`  warn     ${m}`);

async function main() {
  let failed = false;
  const checkKeys = process.argv.includes("--check-keys");

  console.log("\n1. Configuration (names only)");
  for (const v of requiredVariables()) {
    if (v.present) ok(`${v.name}  [gate ${v.gate}]`);
    else {
      bad(`${v.name}  [gate ${v.gate}]`);
      failed = true;
    }
  }

  console.log("\n2. Secrets hygiene");
  try {
    execFileSync("git", ["check-ignore", "-q", ".env"]);
    ok(".env is gitignored");
  } catch {
    bad(".env is NOT gitignored");
    failed = true;
  }
  try {
    const tracked = execFileSync("git", ["ls-files", ".env"]).toString().trim();
    if (tracked) {
      bad(".env is tracked by git; remove it with `git rm --cached .env`");
      failed = true;
    }
  } catch {
    /* not a git repo */
  }

  console.log("\n3. FalkorDB");
  try {
    const counts = await graphCounts();
    ok(`reachable at ${config.falkor.host}:${config.falkor.port}, graph "${config.falkor.graph}"`);
    if (counts.claims === 0) warn("graph is EMPTY: run `pnpm schema && pnpm seed`");
    else ok(`${counts.claims} claims, ${counts.factChecks} fact-checks, ${counts.withEmbedding} with embeddings`);
    const dim = await vectorIndexDimension();
    if (dim === null) {
      bad("vector index on :Claim(embedding) not found: run `pnpm schema`");
      failed = true;
    } else if (dim !== config.embedding.dim) {
      bad(`vector index dimension ${dim} != EMBEDDING_DIM ${config.embedding.dim} (rebuild index and re-embed)`);
      failed = true;
    } else ok(`vector index dimension ${dim} = EMBEDDING_DIM`);
  } catch (err) {
    bad(`FalkorDB: ${err instanceof Error ? err.message : String(err)}`);
    failed = true;
  }

  const usage = await todaysUsage();
  console.log(`\n4. Usage today (Pacific ${usage.day}): ${usage.llmCalls}/${config.budget.maxCallsPerDay} LLM calls, ${usage.embedCalls} embedding calls`);

  if (checkKeys) {
    console.log("\n5. Key validation: makes ONE LLM call (max 128 output tokens, thinking included) and ONE embedding call.");
    if (failed) {
      console.log("  skipped: fix the missing items above first.");
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question("  Proceed? Type 'yes': ")).trim();
      rl.close();
      if (answer === "yes") {
        const budget = new RunBudget();
        try {
          const r = await generateJson({
            task: "preflight",
            system: "Reply with JSON only.",
            user: 'Return {"ok": true}.',
            schema: z.object({ ok: z.boolean() }),
            budget,
            maxTokens: 128,
          });
          ok(`LLM answered via ${r.provider} (${r.model})${r.cached ? " [from cache]" : ""}`);
        } catch (err) {
          bad(`LLM: ${err instanceof Error ? err.message : String(err)}`);
          failed = true;
        }
        try {
          const e = await embed("preflight check", budget);
          ok(`embedding returned ${e.vector.length} dimensions${e.cached ? " [from cache]" : ""}`);
        } catch (err) {
          bad(`Embedding: ${err instanceof Error ? err.message : String(err)}`);
          failed = true;
        }
      } else console.log("  skipped by owner.");
    }
  }

  await closeGraph();
  console.log(failed ? "\nPREFLIGHT FAILED\n" : "\nPREFLIGHT PASSED\n");
  process.exit(failed ? 1 : 0);
}

main();

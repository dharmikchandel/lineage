// pnpm record [--on YYYY-MM-DD]
//
// Rebuilds data/recorded/ for the public deployment (recorded mode). NO API calls.
// Replays every preset through the real pipeline using replies already in the local
// cache (.cache/), and copies each reply it uses into data/recorded/. If a reply is
// missing it stops instead of calling the model: run that preset once in local mode first.
//
// Start from a clean graph (pnpm seed --reset) so the questions asked here are exactly
// the ones a freshly seeded deployment will ask. --on is the day the replies were made.

import { rm } from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { closeGraph, read } from "@/lib/db";
import { RECORDED_DIR, startRecording } from "@/llm/cache";
import { readManifest, replayPresets, writeManifest } from "@/recorded";
import { PRESETS } from "@/lib/presets";

async function main() {
  if (config.mode !== "local") throw new Error("Record from local mode (LINEAGE_MODE=local).");
  const [{ runs }] = await read<{ runs: number }>(`MATCH (a:AgentRun) RETURN count(a) AS runs`);
  if (runs > 0) throw new Error(`The graph already holds ${runs} agent run(s). Start clean: pnpm seed --reset`);

  const i = process.argv.indexOf("--on");
  const recordedOn = (i > 0 ? process.argv[i + 1] : undefined) ?? (await readManifest())?.recordedOn ?? new Date().toLocaleDateString("en-CA");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recordedOn)) throw new Error("--on must be a date like 2026-10-17");

  const manifest = {
    recordedOn,
    model: config.llm.model,
    embeddingModel: config.embedding.model,
    presets: PRESETS.map((p) => p.id),
  };

  for (const bucket of ["llm", "embed"]) await rm(path.join(RECORDED_DIR, bucket), { recursive: true, force: true });
  startRecording();
  console.log(`recording ${manifest.presets.length} presets (replies from .cache/, sighting date ${recordedOn}):`);
  await replayPresets(manifest, console.log);
  await writeManifest(manifest);
  console.log(`saved data/recorded/ (commit it). Before a live demo, start clean again: pnpm seed --reset`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeGraph);

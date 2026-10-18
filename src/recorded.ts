// Recorded mode, for the public deployment (brief, section 14).
//
// Visitors can only pick a preset. Each preset was run once for real; the replies
// the model gave are committed in data/recorded/ (see src/llm/cache.ts). Loading a
// recorded run replays the SAME pipeline: the agents still read and write the graph,
// Q1 still searches the vector index, the Skeptic still applies the rules. Only the
// model's replies come from the recording. The lineage view then runs Q2-Q6 and Q4
// live on every request, like in local mode.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { read } from "@/lib/db";
import { clearAnalysis } from "@/graph/writes";
import { PRESETS } from "@/lib/presets";
import { RECORDED_DIR } from "@/llm/cache";
import { runAnalysis } from "@/pipeline";

const MANIFEST = path.join(RECORDED_DIR, "manifest.json");

export interface RecordedManifest {
  /** The day the model produced these replies; also used as the sighting date of each run. */
  recordedOn: string;
  model: string;
  embeddingModel: string;
  /** Preset ids, in the order they must be replayed (the second NASA paste links to the first). */
  presets: string[];
}

export const recordedAnalysisId = (presetId: string) => `rec-${presetId}`;

export async function readManifest(): Promise<RecordedManifest | null> {
  try {
    return JSON.parse(await readFile(MANIFEST, "utf8")) as RecordedManifest;
  } catch {
    return null;
  }
}

export async function writeManifest(m: RecordedManifest) {
  await writeFile(MANIFEST, `${JSON.stringify(m, null, 2)}\n`);
}

/** Which recorded runs are fully in the graph (the Writer finished). */
export async function loadedRecordedRuns(presetIds: string[]): Promise<string[]> {
  const rows = await read<{ id: string }>(
    // A run counts as loaded once its Writer step finished.
    `MATCH (a:AgentRun {agent: 'writer', status: 'ok'})
     WHERE a.analysis_id IN $ids
     RETURN DISTINCT a.analysis_id AS id`,
    { ids: presetIds.map(recordedAnalysisId) },
  );
  const loaded = new Set(rows.map((r) => r.id));
  return presetIds.filter((p) => loaded.has(recordedAnalysisId(p)));
}

/**
 * Replay every preset through the real pipeline, in order. Skips runs already loaded,
 * so it is safe to repeat. Used by `pnpm seed` (recorded mode) and `pnpm record`.
 */
export async function replayPresets(m: RecordedManifest, log: (line: string) => void) {
  if (config.mode === "recorded" && config.llm.model !== m.model) {
    throw new Error(`The recording was made with ${m.model}; set LLM_MODEL=${m.model} (it is only used to look up recorded replies).`);
  }
  const done = new Set(await loadedRecordedRuns(m.presets));
  for (const presetId of m.presets) {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) throw new Error(`Unknown preset "${presetId}" in data/recorded/manifest.json.`);
    if (done.has(presetId)) {
      log(`  ${presetId}: already loaded`);
      continue;
    }
    await clearAnalysis(recordedAnalysisId(presetId)); // a half-finished earlier attempt, if any
    const r = await runAnalysis(preset.text, { analysisId: recordedAnalysisId(presetId), synthetic: true, sightingDate: m.recordedOn });
    log(`  ${presetId}: replayed (${r.llmCalls} LLM calls, ${r.embedCalls} embedding calls)`);
  }
}

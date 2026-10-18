// Local cache of LLM and embedding responses, keyed by a hash of the exact input.
// It holds model OUTPUT only (JSON text, vectors), never claims or edges: the graph
// stays the only store of domain data. Delete .cache/ at any time; it only costs API calls.
//
// Recorded mode (the public deployment) reads model output from data/recorded/ instead,
// a committed copy of the replies the presets got from real runs, and never calls a model.
// `pnpm record` fills data/recorded/ by copying every reply a preset run uses.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";

type Bucket = "llm" | "embed";

const ROOT = path.join(process.cwd(), ".cache");
export const RECORDED_DIR = path.join(process.cwd(), "data", "recorded");

let recording = false;
/** Used by `pnpm record`: from now on, copy every cached reply that is read into data/recorded/, and never call a model. */
export function startRecording() {
  recording = true;
}

/** Recorded mode, or a recording session: no reply may come from the network. */
export function offline(): boolean {
  return config.mode === "recorded" || recording;
}

export function hashKey(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(dir: string, key: string, value: unknown) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${key}.json`), JSON.stringify(value));
}

export async function cacheGet<T>(bucket: Bucket, key: string): Promise<T | null> {
  if (config.mode === "recorded") return readJson<T>(path.join(RECORDED_DIR, bucket, `${key}.json`));
  const hit = await readJson<T>(path.join(ROOT, bucket, `${key}.json`));
  if (hit !== null && recording) await writeJson(path.join(RECORDED_DIR, bucket), key, hit);
  return hit;
}

export async function cachePut(bucket: Bucket, key: string, value: unknown): Promise<void> {
  await writeJson(path.join(ROOT, bucket), key, value);
}

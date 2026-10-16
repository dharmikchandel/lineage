// Local cache of LLM and embedding responses, keyed by a hash of the exact input.
// It holds model OUTPUT only (JSON text, vectors), never claims or edges: the graph
// stays the only store of domain data. Delete .cache/ at any time; it only costs API calls.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.join(process.cwd(), ".cache");

export function hashKey(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function cacheGet<T>(bucket: "llm" | "embed", key: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(ROOT, bucket, `${key}.json`), "utf8")) as T;
  } catch {
    return null;
  }
}

export async function cachePut(bucket: "llm" | "embed", key: string, value: unknown): Promise<void> {
  const dir = path.join(ROOT, bucket);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${key}.json`), JSON.stringify(value));
}

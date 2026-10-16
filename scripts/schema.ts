// pnpm schema -> create indexes, uniqueness constraints and the vector index (idempotent, no API calls).
import { ensureSchema } from "@/graph/schema";
import { closeGraph } from "@/lib/db";

ensureSchema()
  .then(() => console.log("schema ready"))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeGraph);

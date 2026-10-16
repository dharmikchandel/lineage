// pnpm query <q1|q2|q3|q4|q5|q6> [claimId]
// Runs one named graph query against FalkorDB and prints the raw result. No API calls (Gate 0).
// Q1 here reuses the stored embedding of an existing claim, so it needs no embedding call.

import { config } from "@/lib/config";
import { closeGraph, read } from "@/lib/db";
import { q1Candidates, q2Origins, q3Descendants, q4InheritancePaths, q5Families, q5FamilyOf, q6PublisherSpread } from "@/graph/queries";
import { deriveVerdict } from "@/domain/propagation";

async function main() {
  const [q, id] = process.argv.slice(2).filter((a) => a !== "--");
  const need = () => {
    if (!id) throw new Error(`${q} needs a claim id, e.g. nasa-2017-15day`);
    return id;
  };
  const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));

  switch (q) {
    case "q1": {
      const [row] = await read<{ e: number[] | null }>(`MATCH (c:Claim {id: $id}) RETURN c.embedding AS e`, { id: need() });
      if (!row?.e) throw new Error(`Claim ${id} has no embedding yet (Gate 1: pnpm seed --embed).`);
      return show(await q1Candidates(row.e, 5));
    }
    case "q2":
      return show(await q2Origins(need()));
    case "q3":
      return show(await q3Descendants(need()));
    case "q4": {
      const paths = await q4InheritancePaths(need());
      const v = deriveVerdict(paths, config.propagation);
      return show({ verdict: v.kind, outcomes: v.all.map(({ path, ...rest }) => ({ ...rest, hops: path.hops.length, factCheck: path.factCheck.url })) });
    }
    case "q5":
      return show(id ? await q5FamilyOf(id) : await q5Families());
    case "q6": {
      const fam = await q5FamilyOf(need());
      return show(await q6PublisherSpread(fam?.claimIds ?? [id]));
    }
    default:
      throw new Error("Usage: pnpm query <q1|q2|q3|q4|q5|q6> [claimId]");
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeGraph);

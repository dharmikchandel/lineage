// Shared JSON error handling for API routes. A dead graph is a 503 with a clear
// message, so the UI can show "Lineage cannot work without the graph".
import { NextResponse } from "next/server";
import { GraphUnavailableError, NotFalkorDBError } from "@/lib/db";

export function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const graphDown = err instanceof GraphUnavailableError || err instanceof NotFalkorDBError;
  return NextResponse.json({ error: message, graphDown }, { status: graphDown ? 503 : 500 });
}

// The only connection to domain data. There is deliberately no fallback store:
// if FalkorDB is unreachable, every call here throws and the product stops (brief, rule 3).
import { FalkorDB, type Graph } from "falkordb";
import { config } from "./config";

export class GraphUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `FalkorDB is unreachable at ${config.falkor.host}:${config.falkor.port}. ` +
        `Lineage has no other data store, so it cannot answer without the graph. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "GraphUnavailableError";
  }
}

let dbPromise: Promise<FalkorDB> | null = null;

async function connect(): Promise<FalkorDB> {
  try {
    const db = await FalkorDB.connect({
      socket: {
        host: config.falkor.host,
        port: config.falkor.port,
        connectTimeout: 3000,
        // Passed through to node-redis: do not retry forever; a dead graph should fail fast and visibly.
        reconnectStrategy: false,
      } as never,
      username: config.falkor.username || undefined,
      password: config.falkor.password || undefined,
    });
    // node-redis emits 'error' events on socket problems; without a listener Node
    // crashes the process. We surface the error on the next query instead.
    db.on("error", () => {
      dbPromise = null;
    });
    return db;
  } catch (err) {
    dbPromise = null;
    throw new GraphUnavailableError(err);
  }
}

export async function getGraph(): Promise<Graph> {
  dbPromise ??= connect();
  const db = await dbPromise;
  return db.selectGraph(config.falkor.graph);
}

export type Params = Record<string, unknown>;

/** Run a read-write query and return rows as objects keyed by column alias. */
export async function run<T = Record<string, unknown>>(cypher: string, params: Params = {}): Promise<T[]> {
  const graph = await getGraph();
  try {
    const res = await graph.query<T>(cypher, { params: params as never });
    return res.data ?? [];
  } catch (err) {
    if (isConnectionError(err)) {
      dbPromise = null;
      throw new GraphUnavailableError(err);
    }
    if (/unknown command 'GRAPH\./i.test(err instanceof Error ? err.message : "")) throw new NotFalkorDBError();
    throw err;
  }
}

/** Run a read-only query (GRAPH.RO_QUERY), used for all Q1-Q6 reads. */
export async function read<T = Record<string, unknown>>(cypher: string, params: Params = {}): Promise<T[]> {
  const graph = await getGraph();
  try {
    const res = await graph.roQuery<T>(cypher, { params: params as never });
    return res.data ?? [];
  } catch (err) {
    if (isConnectionError(err)) {
      dbPromise = null;
      throw new GraphUnavailableError(err);
    }
    // FalkorDB rejects RO_QUERY on a graph key that does not exist yet (fresh database, before
    // `pnpm seed`). A graph that was never created is an empty graph, so read it as one.
    if (/empty key/i.test(err instanceof Error ? err.message : "")) return [];
    if (/unknown command 'GRAPH\./i.test(err instanceof Error ? err.message : "")) throw new NotFalkorDBError();
    throw err;
  }
}

export class NotFalkorDBError extends Error {
  constructor() {
    super(
      `The server at ${config.falkor.host}:${config.falkor.port} is a Redis without the FalkorDB module ` +
        `(no GRAPH.* commands). Point FALKORDB_HOST/FALKORDB_PORT at FalkorDB (docker compose up -d).`,
    );
    this.name = "NotFalkorDBError";
  }
}

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ClientClosed|closed|Socket/i.test(msg);
}

export async function closeGraph(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise.catch(() => null);
  dbPromise = null;
  await db?.close();
}

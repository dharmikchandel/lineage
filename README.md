# Lineage

> Everyone gets their news from reels. A claim is never new; it's a mutation of something older. Lineage shows you the family tree.

Paste a claim. Lineage's agents split it into atomic claims, find where each came from, how it mutated, who pushed it and what evidence exists. The answer is an **evidence trail with calibrated confidence**, drawn as a lineage graph, or **"Unknown"** when the graph has nothing. It never gives a bare true/false.

**Graph Hacks 2026 (WeMakeDevs × FalkorDB).** Tracks: **Track 1: Agents That Act on Connected Data** and **Track 2: Agent Memory and Coordination**.

> Status: work in progress (Oct 16). CLI and graph layer are in place; the UI lands Oct 17.

## Local setup

Requirements: Node.js 20+, pnpm 10+ (`npm install -g pnpm`, or `corepack enable`), Docker.

```bash
pnpm install
cp .env.example .env          # then fill in GEMINI_API_KEY (free key from Google AI Studio)
docker compose up -d          # FalkorDB on localhost:6380, FalkorDB Browser on http://localhost:3001
pnpm schema                   # indexes, constraints, vector index (no API calls)
pnpm seed                     # load the seed stories (no API calls; uses committed embeddings)
pnpm preflight                # checks config names, .env is gitignored, FalkorDB, vector index dimension
pnpm test                     # unit tests for the verdict propagation rules
```

Ports default to 6380 / 3001 so they do not clash with a local Redis on 6379 or Next.js on 3000.

Analyse a claim from the CLI (makes real API calls; at most 3 LLM calls and 1 embedding call per claim):

```bash
pnpm analyze --go --synthetic "NASA confirms Earth will go dark for 15 days in November 2026"
```

Inspect any named query without API calls:

```bash
pnpm query q2 nasa-2017-15day # origin tracing
pnpm query q4 nasa-2017-15day # inherited verdict
pnpm query q5                 # story families
```

**Privacy note.** On Gemini's free tier Google may use submitted text to improve its products. Do not paste private information.

## Graph data model

```
(Sighting)-[:SIGHTING_OF]->(Claim)            one appearance of a claim in the world
(Sighting)-[:PUBLISHED_BY]->(Publisher)       who posted it
(Claim)-[:MUTATED_FROM]->(Claim)              child points to parent; a DAG, never a cycle
(Claim)-[:ORIGINATES_FROM]->(Source|Publisher)  several edges = contested origin
(Claim)-[:CHECKED_BY]->(FactCheck)            verdict + basis (WHY it was judged false)
(AgentRun)-[:FOUND]->(Finding)-[:ABOUT]->(Claim)  the agents' shared memory
```

| Node | Key properties |
|---|---|
| `Claim` | id, text (our paraphrase), embedding (vector), first_seen, attributed_to, synthetic |
| `Sighting` | id, url, date, date_note, snippet (our paraphrase), reported_by, synthetic |
| `Publisher` | name, url, kind, synthetic |
| `Source` | name, url, kind |
| `FactCheck` | url, publisher, date, verdict, basis, summary |
| `AgentRun` / `Finding` | agent, method (llm / rule-based), provider, model, cached / kind, summary, data |

`MUTATED_FROM` edges carry `types` (number_change, date_shift, context_stripped, exaggeration, attribution_change), `before_text`, `after_text`, `confidence`, `asserted_by`, `at`, `direction_certain`.

## The queries the product depends on

All in `src/graph/queries.ts`, each commented in plain English.

- **Q1 Candidate retrieval:** vector nearest neighbours (`db.idx.vector.queryNodes`) with each candidate's fact-checks.
- **Q2 Origin tracing:** follow `MUTATED_FROM` up to the root(s); return every `ORIGINATES_FROM` on the way (contested origins show all).
- **Q3 Descendants / spread:** follow `MUTATED_FROM` down; variants by date with publishers.
- **Q4 Inherited verdict:** variable-length upward traversal to fact-checked ancestors, then the basis rule (`src/domain/propagation.ts`) with per-hop decay. *A debunk travels exactly as far as its reason still applies.*
- **Q5 Story families:** weakly connected components (`algo.WCC`) over `MUTATED_FROM`: "N variants, M years".
- **Q6 Publisher spread:** who posted which variant and when.

Design decisions and their reasons: [DECISIONS.md](DECISIONS.md). AI-use disclosure: [AI_USAGE.md](AI_USAGE.md).

## Data

Seed stories are built from public fact-checks (PolitiFact, FactCheck.org, ThatsNonsense, EarthSky, Snopes via news coverage). We store a short paraphrase of each claim and the fact-check URL, never article text. Anything we generated (such as demo inputs) is stored with `synthetic=true` and labelled "synthetic demo data" wherever it appears.

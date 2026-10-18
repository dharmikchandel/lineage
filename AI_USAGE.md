# AI use

Lineage was built by Dharmik Chandel for Graph Hacks 2026, with **Claude Code** (Anthropic) as the coding assistant. This file says who did what.

## What I designed

- **The product idea.** An evidence trail with calibrated confidence instead of a true/false label; "Unknown" when the graph has nothing; a graph that compounds with every check.
- **The graph model.** The nodes (`Claim`, `Sighting`, `Publisher`, `Source`, `FactCheck`, `AgentRun`, `Finding`), the edges and their properties, `MUTATED_FROM` as a directed acyclic graph pointing from child to parent, several `ORIGINATES_FROM` edges meaning a contested origin, and verdicts derived at query time rather than stored.
- **The mutation types.** `number_change`, `date_shift`, `attribution_change`, `exaggeration` and `context_stripped` (best effort). Entity swap was left out on purpose.
- **Verdict propagation.** The principle (a debunk travels exactly as far as its reason still applies), the basis table, the four global rules (only negative verdicts travel, per-hop decay with a threshold, fail safe, name the mutation that broke it) and the three worked cases the tests check.
- **The queries.** The six named queries Q1-Q6 and what each must return: vector candidates with their fact-checks, origin tracing with contested origins, descendants, the inherited-verdict traversal, story families with connected components, and publisher spread.
- **The agents.** Four agents (Extractor, Linker, Skeptic, Writer) that coordinate only through `AgentRun` / `Finding` nodes in the graph, a rule-based Skeptic, and the call budget per claim.
- **The honesty rules.** A verdict always comes with its basis, confidence and path; synthetic data is always labelled; sources are never invented.
- **Running on a free tier.** Caching, budgets, and recorded mode for the public deployment.
- **The demo.** The NASA darkness hoax as the hero chain, the "Bill Gates' 11 rules" correction as the backup, the second-paste moment and the Unknown case.
- **Calls made during the build.** Linking a new claim to the closest version of a chain by similarity, the wording of the demo claims, and the visual direction (dark and technical in the style of Linear, with sleek motion).

## What Claude Code did

- **The implementation.** All TypeScript, including the Cypher text of the queries, the write-back functions, the agents, the LLM, embedding, cache and budget clients, the CLI scripts, Docker Compose and the project scaffolding.
- **The interface.** The UI design and code, built to the visual direction above.
- **Tests and docs.** The unit tests for the rules, and drafts of the README.
- **Seed research.** It read the cited fact-check pages and drafted the short paraphrases and URLs in `data/seed/`. Where sources disagree, it recorded both versions with a note instead of picking one.
- **Implementation details it proposed along the way.** For example: running Q4's traversal in Cypher and its basis rule as a pure, unit-tested function; multiplying each edge's own confidence into the per-hop decay; collecting origins along the whole chain in Q2; the 0.75 similarity cutoff before the Linker's LLM call; the Skeptic's 0.9 confidence penalties; the Writer's check against invented numbers and URLs; ids derived from claim text; the hand-drawn timeline layout; and implementing recorded mode as a replay through the real pipeline.

## AI inside the product

- **Gemini** (`LLM_MODEL`, currently `gemini-3.5-flash-lite`) runs the Extractor, the Linker's judgment and the Writer's wording. The Skeptic uses no model.
- **gemini-embedding-001** (768 dimensions) makes the claim vectors for the FalkorDB vector index.
- Every model call is shown in the agent trace with its provider and model, and whether the reply came from the cache or a recording.

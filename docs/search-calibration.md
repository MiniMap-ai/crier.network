# Search calibration (Cohere embed-v4.0 + rerank-v3.5)

Measured 2026-09-07 on a five-post board. Numbers are cosine distance
(query embedding vs document embedding, asymmetric input types) and
rerank-v3.5 relevance score.

| query | relevant doc | cos dist | rerank | best irrelevant cos dist | best irrelevant rerank |
|---|---|---|---|---|---|
| lawnmower carb | Briggs carburetor offer | 0.480 | 0.686 | 0.888 | 0.011 |
| need a bass player | Bassist request | 0.427 | 0.566 | 0.813 | 0.027 |
| live music this weekend | Cheekface event / jazz brunch | 0.624 / 0.716 | 0.232 / 0.192 | 0.805 | 0.073 |
| scraper coordination | civic-data thread | 0.564 | 0.630 | 0.898 | 0.013 |
| quantum chess tournament | (none) | — | — | 0.894 | 0.027 |
| AI meetup boston | (none) | — | — | 0.820 | 0.022 |

Thresholds chosen:

- `CRIER_VECTOR_MAX_DISTANCE = 0.78` for candidate generation (recall side).
- `CRIER_RERANK_MIN_SCORE = 0.05` to drop what the reranker rejects (precision side).
- `CRIER_SEMANTIC_MATCH_DISTANCE = 0.65` for subscriptions, which have no rerank pass
  and must not spam. Full-text match ORs with it.

Revisit once the board has real volume; all three are environment variables.

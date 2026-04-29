"""Knowledge-base retrieval.

Two public entry points:

* :func:`retrieve` — single-vector search. Embed one query, run the SQL
  ``match_chunks`` RPC, hydrate with source metadata.
* :func:`retrieve_multi` — multi-vector search with Reciprocal Rank Fusion
  and a per-source diversity cap. Used by the chat orchestrator after the
  decomposition step so compound questions ("X and Y") don't lose recall on
  whichever sub-topic happens to have a weaker gradient in the corpus.

The fusion pass and the diversity cap together raise cross-source recall
without re-ranking or schema changes.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from supabase import Client

from ..ingestion.embedder import embed_texts


@dataclass
class RetrievedChunk:
    id: str
    source_id: str
    source_title: str
    source_type: str
    source_url: str | None
    chunk_index: int
    content: str
    similarity: float


# Reciprocal Rank Fusion constant. The original Cormack/Clarke/Buettcher paper
# uses k=60; smaller values amplify rank-1 weight, larger values flatten the
# curve. 60 is the well-known default and works fine across query counts.
_RRF_K = 60


async def _hydrate_sources(
    db: Client, rows_by_source: dict[str, list[dict]]
) -> dict[str, dict]:
    """Look up source metadata (title / type / url) for the given source ids."""
    if not rows_by_source:
        return {}
    src_resp = (
        db.table("sources")
        .select("id,title,type,url")
        .in_("id", list(rows_by_source.keys()))
        .execute()
    )
    return {s["id"]: s for s in (src_resp.data or [])}


def _row_to_chunk(row: dict, sources: dict[str, dict]) -> RetrievedChunk:
    s = sources.get(row["source_id"], {})
    return RetrievedChunk(
        id=row["id"],
        source_id=row["source_id"],
        source_title=s.get("title") or "Untitled source",
        source_type=s.get("type") or "text",
        source_url=s.get("url"),
        chunk_index=row["chunk_index"],
        content=row["content"],
        similarity=float(row["similarity"]),
    )


async def _match_chunks(
    db: Client,
    *,
    user_id: str,
    vector: list[float],
    match_count: int,
) -> list[dict]:
    """Run a single match_chunks RPC call and return raw rows."""
    resp = db.rpc(
        "match_chunks",
        {
            "query_embedding": vector,
            "match_count": match_count,
            "owner_id": user_id,
        },
    ).execute()
    return resp.data or []


async def retrieve(
    db: Client,
    *,
    user_id: str,
    query: str,
    top_k: int,
) -> list[RetrievedChunk]:
    """Return the top-k most similar chunks for `query` scoped to `user_id`."""
    if not query.strip():
        return []

    [vector] = await embed_texts([query])
    rows = await _match_chunks(db, user_id=user_id, vector=vector, match_count=top_k)
    if not rows:
        return []

    rows_by_source: dict[str, list[dict]] = {}
    for r in rows:
        rows_by_source.setdefault(r["source_id"], []).append(r)
    sources = await _hydrate_sources(db, rows_by_source)
    return [_row_to_chunk(r, sources) for r in rows]


def _rrf_fuse(
    ranked_lists: list[list[dict]], *, k: int = _RRF_K
) -> list[tuple[dict, float]]:
    """Fuse multiple ranked lists using Reciprocal Rank Fusion.

    For each list, a row at position ``rank`` (0-indexed) contributes
    ``1 / (k + rank + 1)`` to that row's fused score. Rows that appear in
    multiple lists get added contributions, which is how cross-cutting
    chunks rise to the top.

    Returns a list of (row, score) tuples, sorted by score desc.
    """
    by_id: dict[str, dict] = {}
    scores: dict[str, float] = {}
    for ranked in ranked_lists:
        for rank, row in enumerate(ranked):
            cid = row["id"]
            if cid not in by_id:
                by_id[cid] = row
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank + 1)
    fused = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    return [(by_id[cid], score) for cid, score in fused]


def _apply_diversity_cap(
    fused: list[tuple[dict, float]],
    *,
    max_per_source: int,
    final_top_k: int,
) -> list[dict]:
    """Walk fused rows in score order, capping how many can come from any
    one source until we've collected `final_top_k` rows.

    A chatty document with five chunks all ranking highly would otherwise
    crowd out a less verbose source whose single chunk is also relevant.
    The cap guarantees breadth without re-ranking.

    If we exhaust the fused list before hitting the cap-respecting target,
    we relax the cap and fill from the leftovers in the original score
    order so we never return fewer than `min(len(fused), final_top_k)`.
    """
    out: list[dict] = []
    counts: dict[str, int] = {}
    overflow: list[dict] = []
    for row, _score in fused:
        sid = row["source_id"]
        if counts.get(sid, 0) >= max_per_source:
            overflow.append(row)
            continue
        out.append(row)
        counts[sid] = counts.get(sid, 0) + 1
        if len(out) >= final_top_k:
            return out
    for row in overflow:
        if len(out) >= final_top_k:
            break
        out.append(row)
    return out


async def retrieve_multi(
    db: Client,
    *,
    user_id: str,
    queries: list[str],
    top_k_per_query: int,
    final_top_k: int,
    max_per_source: int,
) -> list[RetrievedChunk]:
    """Multi-vector retrieve with RRF fusion + per-source diversity cap.

    Behaviour:
    - Empty / blank queries are filtered out. If nothing remains, returns ``[]``.
    - Single non-empty query degrades to plain ``retrieve`` ordering.
    - Embeddings for every query are batched into one OpenAI call.
    - ``match_chunks`` is fanned out concurrently per query.
    - Returned chunks are sorted by their fused RRF score (desc), then
      passed through the diversity cap.
    """
    cleaned = [q.strip() for q in queries if q and q.strip()]
    if not cleaned:
        return []

    vectors = await embed_texts(cleaned)

    rpc_calls = [
        _match_chunks(db, user_id=user_id, vector=v, match_count=top_k_per_query)
        for v in vectors
    ]
    ranked_lists = await asyncio.gather(*rpc_calls)

    if not any(ranked_lists):
        return []

    fused = _rrf_fuse(ranked_lists)
    if not fused:
        return []

    selected = _apply_diversity_cap(
        fused,
        max_per_source=max_per_source,
        final_top_k=final_top_k,
    )

    rows_by_source: dict[str, list[dict]] = {}
    for r in selected:
        rows_by_source.setdefault(r["source_id"], []).append(r)
    sources = await _hydrate_sources(db, rows_by_source)
    return [_row_to_chunk(r, sources) for r in selected]

"""Knowledge-base retrieval.

Uses the SQL ``match_chunks`` RPC (defined in the initial migration) to run
cosine similarity search against the user's chunks, then hydrates the result
with source titles / types so the caller can cite them.
"""

from __future__ import annotations

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

    resp = db.rpc(
        "match_chunks",
        {
            "query_embedding": vector,
            "match_count": top_k,
            "owner_id": user_id,
        },
    ).execute()

    rows = resp.data or []
    if not rows:
        return []

    source_ids = list({r["source_id"] for r in rows})
    src_resp = (
        db.table("sources")
        .select("id,title,type,url")
        .in_("id", source_ids)
        .execute()
    )
    sources = {s["id"]: s for s in (src_resp.data or [])}

    out: list[RetrievedChunk] = []
    for r in rows:
        s = sources.get(r["source_id"], {})
        out.append(
            RetrievedChunk(
                id=r["id"],
                source_id=r["source_id"],
                source_title=s.get("title") or "Untitled source",
                source_type=s.get("type") or "text",
                source_url=s.get("url"),
                chunk_index=r["chunk_index"],
                content=r["content"],
                similarity=float(r["similarity"]),
            )
        )
    return out

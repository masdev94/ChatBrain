"""Chunk endpoints.

Read-only endpoints used by the citation drawer: given a chunk id, return
that chunk's full content together with the chunk immediately before and
after it within the same source. The drawer renders the result so a user
can verify a citation in context without leaving the answer.

We intentionally don't expose write operations here — chunks are produced
exclusively by the ingestion pipeline.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from supabase import Client

from ..core.auth import user_db

router = APIRouter(prefix="/chunks", tags=["chunks"])


class ChunkOut(BaseModel):
    id: str
    source_id: str
    chunk_index: int
    content: str
    token_count: int
    created_at: str


class SourceSummary(BaseModel):
    id: str
    title: str
    type: Literal["pdf", "text", "url"]
    url: str | None = None


class ChunkNeighboursOut(BaseModel):
    """The clicked chunk plus its immediate neighbours, plus enough source
    metadata for the drawer to render a header without a second round-trip.
    """
    source: SourceSummary
    previous: ChunkOut | None
    current: ChunkOut
    next: ChunkOut | None


@router.get("/{chunk_id}/neighbours", response_model=ChunkNeighboursOut)
async def get_chunk_neighbours(
    chunk_id: str, db: Client = Depends(user_db)
) -> ChunkNeighboursOut:
    """Return the chunk identified by `chunk_id` together with its previous
    and next chunks (by `chunk_index`) inside the same source.

    Auth: callers go through the JWT-scoped Supabase client so RLS already
    restricts the result to chunks the user owns. A 404 here therefore
    means either "doesn't exist" or "not yours" — we deliberately don't
    distinguish.
    """
    resp = (
        db.table("chunks")
        .select("id,source_id,chunk_index,content,token_count,created_at")
        .eq("id", chunk_id)
        .maybe_single()
        .execute()
    )
    if not resp or not resp.data:
        raise HTTPException(status_code=404, detail="Chunk not found")
    current = resp.data
    source_id: str = current["source_id"]
    idx: int = current["chunk_index"]

    src_resp = (
        db.table("sources")
        .select("id,title,type,url")
        .eq("id", source_id)
        .maybe_single()
        .execute()
    )
    if not src_resp or not src_resp.data:
        raise HTTPException(status_code=404, detail="Source not found")

    # One round-trip for both neighbours by selecting the +/- 1 indices.
    nbr_resp = (
        db.table("chunks")
        .select("id,source_id,chunk_index,content,token_count,created_at")
        .eq("source_id", source_id)
        .in_("chunk_index", [idx - 1, idx + 1])
        .order("chunk_index")
        .execute()
    )
    rows = nbr_resp.data or []
    previous = next((r for r in rows if r["chunk_index"] == idx - 1), None)
    nxt = next((r for r in rows if r["chunk_index"] == idx + 1), None)

    return ChunkNeighboursOut(
        source=SourceSummary(**src_resp.data),
        previous=ChunkOut(**previous) if previous else None,
        current=ChunkOut(**current),
        next=ChunkOut(**nxt) if nxt else None,
    )

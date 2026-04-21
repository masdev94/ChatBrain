"""Citation extraction maps inline [Sn] tags back to real sources."""

from __future__ import annotations

from app.rag.chat import _extract_citations
from app.rag.retrieval import RetrievedChunk


def _chunk(i: int, src: str, title: str) -> RetrievedChunk:
    return RetrievedChunk(
        id=f"c{i}",
        source_id=src,
        source_title=title,
        source_type="text",
        source_url=None,
        chunk_index=i,
        content=f"content {i}",
        similarity=0.9 - 0.01 * i,
    )


def test_dedupes_citations_by_source() -> None:
    chunks = [
        _chunk(0, "src-A", "Return Policy"),
        _chunk(1, "src-A", "Return Policy"),       # same source, different chunk
        _chunk(2, "src-B", "Product Page"),
    ]
    answer = "Returns accepted in 30 days [S1][S2]. Shipping is free [S3]."

    cites = _extract_citations(answer, chunks)

    assert [c["source_id"] for c in cites] == ["src-A", "src-B"]
    assert cites[0]["tag"] == "S1"  # first hit wins for src-A
    assert cites[1]["tag"] == "S3"


def test_ignores_out_of_range_tags() -> None:
    chunks = [_chunk(0, "src-A", "Only Source")]
    answer = "Claim [S1] and bogus [S99]."
    cites = _extract_citations(answer, chunks)
    assert [c["source_id"] for c in cites] == ["src-A"]


def test_no_citations_when_model_drops_tags() -> None:
    chunks = [_chunk(0, "src-A", "Only Source")]
    assert _extract_citations("plain prose, no brackets", chunks) == []

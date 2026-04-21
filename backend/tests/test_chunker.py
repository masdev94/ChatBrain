"""Chunker invariants.

We verify the contracts the retriever depends on:

* Every chunk stays within the target token budget (plus overlap headroom).
* Successive chunks share ~overlap_tokens of tail-to-head text.
* chunk_index values are contiguous starting at 0.
* Very small inputs produce exactly one chunk.
* Pathological whitespace-free inputs don't blow up.
"""

from __future__ import annotations

from app.ingestion.chunker import chunk_text, count_tokens


def test_short_text_produces_single_chunk() -> None:
    text = "Hello world. This is a tiny document."
    chunks = chunk_text(text, target_tokens=800, overlap_tokens=100)
    assert len(chunks) == 1
    assert chunks[0].index == 0
    assert chunks[0].content == text.strip()
    assert chunks[0].token_count == count_tokens(text.strip())


def test_long_text_respects_target_token_budget() -> None:
    paragraph = "The quick brown fox jumps over the lazy dog. " * 200
    chunks = chunk_text(paragraph, target_tokens=100, overlap_tokens=20)

    assert len(chunks) > 1
    for i, c in enumerate(chunks):
        assert c.index == i
        # Allow a generous slack factor: the last atom packed may push past
        # the strict budget, but we never want wild outliers.
        assert c.token_count <= 200


def test_chunks_share_overlap() -> None:
    text = "\n\n".join(f"Paragraph {i}: " + ("lorem ipsum " * 30) for i in range(8))
    chunks = chunk_text(text, target_tokens=120, overlap_tokens=30)

    assert len(chunks) >= 2
    for prev, nxt in zip(chunks, chunks[1:]):
        prev_tail = prev.content[-60:]
        # Some tokens from the previous chunk's tail should appear near the
        # head of the next chunk. We look for a 20-char substring overlap.
        found = any(prev_tail[i : i + 20] in nxt.content[:120] for i in range(0, 40))
        assert found, f"expected overlap between chunk {prev.index} and {nxt.index}"


def test_whitespace_free_pathological_input() -> None:
    # No spaces or separators: must still chunk by hard token cut.
    text = "x" * 20_000
    chunks = chunk_text(text, target_tokens=200, overlap_tokens=0)
    assert len(chunks) > 1
    assert all(c.token_count <= 400 for c in chunks)


def test_empty_input_returns_no_chunks() -> None:
    assert chunk_text("", target_tokens=800, overlap_tokens=100) == []
    assert chunk_text("   \n\n  ", target_tokens=800, overlap_tokens=100) == []

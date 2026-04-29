"""Retrieval fusion: RRF, diversity cap, and the multi-query orchestrator.

These tests exercise the logic-only paths (no real DB or OpenAI). The
embedder and Supabase RPC are stubbed via monkeypatch so we can validate
the deterministic fusion + capping behaviour.
"""

from __future__ import annotations

import pytest

from app.rag import retrieval


def _row(
    chunk_id: str, source_id: str, *, idx: int = 0, content: str = "x", sim: float = 0.5
) -> dict:
    return {
        "id": chunk_id,
        "source_id": source_id,
        "chunk_index": idx,
        "content": content,
        "similarity": sim,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Pure-function tests: RRF + diversity cap
# ─────────────────────────────────────────────────────────────────────────────


def test_rrf_single_list_preserves_order() -> None:
    """One query in, the fused order matches that query's rank order."""
    ranked = [_row("a", "s1"), _row("b", "s2"), _row("c", "s3")]
    fused = retrieval._rrf_fuse([ranked])
    assert [r["id"] for r, _ in fused] == ["a", "b", "c"]


def test_rrf_two_lists_promotes_cross_cutting_chunk() -> None:
    """A chunk that appears in both lists should outrank chunks unique to one."""
    list_a = [_row("shared", "s1"), _row("only_a", "s2"), _row("filler_a", "s3")]
    list_b = [_row("only_b", "s4"), _row("shared", "s1"), _row("filler_b", "s5")]

    fused = retrieval._rrf_fuse([list_a, list_b])
    ids = [r["id"] for r, _ in fused]

    # 'shared' is at rank 0 in A and rank 1 in B → score = 1/61 + 1/62 ≈ 0.0325
    # 'only_a' rank 1 → 1/62 ≈ 0.0161
    # 'only_b' rank 0 → 1/61 ≈ 0.0164
    # Shared must beat both unique-to-one entries.
    assert ids[0] == "shared"
    assert set(ids[1:3]) == {"only_a", "only_b"}


def test_rrf_empty_inputs() -> None:
    assert retrieval._rrf_fuse([]) == []
    assert retrieval._rrf_fuse([[]]) == []
    assert retrieval._rrf_fuse([[], []]) == []


def test_diversity_cap_drops_overflow_from_chatty_source() -> None:
    """When one source contributes 5 of the top fused rows but the cap is 3
    and final_top_k can be filled entirely in-band, the 4th and 5th must
    not appear in the output."""
    fused = [
        (_row(f"c{i}", "chatty"), 1.0 - i * 0.01) for i in range(5)
    ] + [
        (_row("q1", "quiet1"), 0.9),
        (_row("q2", "quiet2"), 0.85),
    ]
    # final_top_k=5 is fillable from in-band (3 chatty + q1 + q2) so the
    # cap holds strictly here.
    selected = retrieval._apply_diversity_cap(
        fused, max_per_source=3, final_top_k=5
    )
    by_source: dict[str, int] = {}
    for r in selected:
        by_source[r["source_id"]] = by_source.get(r["source_id"], 0) + 1
    assert by_source["chatty"] == 3
    assert by_source["quiet1"] == 1
    assert by_source["quiet2"] == 1


def test_diversity_cap_relaxes_to_meet_final_top_k_when_in_band_is_short() -> None:
    """If respecting the cap would leave us under `final_top_k`, the cap
    relaxes and we fill from overflow in score order. We must never return
    *fewer* rows than `min(len(fused), final_top_k)`."""
    fused = [
        (_row(f"c{i}", "chatty"), 1.0 - i * 0.01) for i in range(5)
    ] + [
        (_row("q1", "quiet1"), 0.9),
    ]
    # cap=2, target=5 → in-band yields 3 rows (c0, c1, q1). To reach 5
    # we must dip into overflow even though it breaks the cap.
    selected = retrieval._apply_diversity_cap(
        fused, max_per_source=2, final_top_k=5
    )
    assert len(selected) == 5
    ids = [r["id"] for r in selected]
    # In-band rows always come first:
    assert ids[:3] == ["c0", "c1", "q1"]
    # Overflow refills with the next-best chatty rows:
    assert set(ids[3:]) == {"c2", "c3"}


def test_diversity_cap_relaxes_when_only_one_source_is_available() -> None:
    """If every fused row is from the same source we shouldn't return 0
    rows just because the cap was hit — relax and fill from overflow."""
    fused = [(_row(f"c{i}", "only"), 1.0 - i * 0.01) for i in range(6)]
    selected = retrieval._apply_diversity_cap(
        fused, max_per_source=2, final_top_k=5
    )
    # Cap of 2 from one source → only 2 in-band, but then we fill from
    # overflow because there's nothing else, up to final_top_k=5.
    assert len(selected) == 5
    assert all(r["source_id"] == "only" for r in selected)


def test_diversity_cap_truncates_to_final_top_k() -> None:
    fused = [(_row(f"c{i}", f"s{i}"), 1.0 - i * 0.01) for i in range(20)]
    selected = retrieval._apply_diversity_cap(
        fused, max_per_source=1, final_top_k=4
    )
    assert len(selected) == 4
    assert [r["id"] for r in selected] == ["c0", "c1", "c2", "c3"]


# ─────────────────────────────────────────────────────────────────────────────
# Orchestrator: retrieve_multi end-to-end with stubs
# ─────────────────────────────────────────────────────────────────────────────


class _FakeDB:
    """Minimal Supabase client double — only what retrieve_multi touches."""

    def __init__(self, sources: list[dict]) -> None:
        self._sources = sources

    def table(self, _name: str):
        return _FakeTableQuery(self._sources)


class _FakeTableQuery:
    def __init__(self, sources: list[dict]) -> None:
        self._sources = sources
        self._ids: list[str] = []

    def select(self, _cols: str):
        return self

    def in_(self, _col: str, ids: list[str]):
        self._ids = ids
        return self

    def execute(self):
        class _Resp:
            def __init__(self, data: list[dict]) -> None:
                self.data = data

        return _Resp([s for s in self._sources if s["id"] in self._ids])


@pytest.fixture
def fake_sources() -> list[dict]:
    return [
        {"id": "s1", "title": "Refund SOP", "type": "text", "url": None},
        {"id": "s2", "title": "Cancel SOP", "type": "text", "url": None},
        {"id": "s3", "title": "Other", "type": "text", "url": None},
    ]


async def test_retrieve_multi_blank_queries_returns_empty(
    monkeypatch, fake_sources
) -> None:
    db = _FakeDB(fake_sources)

    async def _no_embed(_texts):
        raise AssertionError("embed_texts should not be called for blank input")

    monkeypatch.setattr(retrieval, "embed_texts", _no_embed)

    out = await retrieval.retrieve_multi(
        db,  # type: ignore[arg-type]
        user_id="u",
        queries=["", "   ", ""],
        top_k_per_query=4,
        final_top_k=5,
        max_per_source=3,
    )
    assert out == []


async def test_retrieve_multi_single_query_matches_legacy_order(
    monkeypatch, fake_sources
) -> None:
    """One query in → fused order is the RPC's order, hydrated to chunks."""
    db = _FakeDB(fake_sources)
    rpc_rows = [
        _row("a", "s1", idx=0, content="alpha", sim=0.9),
        _row("b", "s2", idx=0, content="beta", sim=0.8),
        _row("c", "s3", idx=0, content="gamma", sim=0.7),
    ]

    async def _embed(_texts):
        return [[0.0] * 1536 for _ in _texts]

    async def _match(_db, *, user_id, vector, match_count):
        return rpc_rows[:match_count]

    monkeypatch.setattr(retrieval, "embed_texts", _embed)
    monkeypatch.setattr(retrieval, "_match_chunks", _match)

    out = await retrieval.retrieve_multi(
        db,  # type: ignore[arg-type]
        user_id="u",
        queries=["only one"],
        top_k_per_query=3,
        final_top_k=3,
        max_per_source=3,
    )
    assert [c.id for c in out] == ["a", "b", "c"]
    assert out[0].source_title == "Refund SOP"


async def test_retrieve_multi_two_queries_fuses_disjoint_top_hits(
    monkeypatch, fake_sources
) -> None:
    """Two compound questions → both hits surface near the top after RRF."""
    db = _FakeDB(fake_sources)

    async def _embed(_texts):
        return [[0.0] * 1536 for _ in _texts]

    # Q1 finds 'refund' first, Q2 finds 'cancel' first. Without fusion either
    # one would dominate; with fusion both rank-0 chunks should land at top-2.
    rpc_lists = {
        0: [
            _row("refund_top", "s1", sim=0.95),
            _row("filler_a", "s3", sim=0.6),
        ],
        1: [
            _row("cancel_top", "s2", sim=0.93),
            _row("filler_b", "s3", sim=0.55),
        ],
    }
    call_idx = {"i": 0}

    async def _match(_db, *, user_id, vector, match_count):
        i = call_idx["i"]
        call_idx["i"] += 1
        return rpc_lists[i][:match_count]

    monkeypatch.setattr(retrieval, "embed_texts", _embed)
    monkeypatch.setattr(retrieval, "_match_chunks", _match)

    out = await retrieval.retrieve_multi(
        db,  # type: ignore[arg-type]
        user_id="u",
        queries=["What's our refund policy?", "How do I cancel?"],
        top_k_per_query=2,
        final_top_k=4,
        max_per_source=3,
    )
    ids = [c.id for c in out]
    # Both rank-0 chunks must land in the top 2 (order between them is
    # deterministic based on which list comes first, but both are present).
    assert set(ids[:2]) == {"refund_top", "cancel_top"}
    assert "filler_a" in ids and "filler_b" in ids


async def test_retrieve_multi_diversity_cap_kicks_in(
    monkeypatch, fake_sources
) -> None:
    """If one source crowds the top, the cap should leave room for others."""
    db = _FakeDB(fake_sources)

    async def _embed(_texts):
        return [[0.0] * 1536 for _ in _texts]

    # Single query path; chatty source 's1' has 5 top hits, then 's2', 's3'.
    rows = [
        _row("c0", "s1"),
        _row("c1", "s1"),
        _row("c2", "s1"),
        _row("c3", "s1"),
        _row("c4", "s1"),
        _row("d0", "s2"),
        _row("e0", "s3"),
    ]

    async def _match(_db, *, user_id, vector, match_count):
        return rows[:match_count]

    monkeypatch.setattr(retrieval, "embed_texts", _embed)
    monkeypatch.setattr(retrieval, "_match_chunks", _match)

    # Pick final_top_k so the cap is fillable purely in-band (2 + 1 + 1 = 4).
    out = await retrieval.retrieve_multi(
        db,  # type: ignore[arg-type]
        user_id="u",
        queries=["q"],
        top_k_per_query=7,
        final_top_k=4,
        max_per_source=2,
    )
    by_source: dict[str, int] = {}
    for c in out:
        by_source[c.source_id] = by_source.get(c.source_id, 0) + 1
    assert by_source.get("s1", 0) == 2
    assert by_source.get("s2", 0) == 1
    assert by_source.get("s3", 0) == 1

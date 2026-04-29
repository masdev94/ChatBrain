"""Long-term memory: summarize / write / retrieve, plus an integration
test that proves memories actually flow into the decomposer.

All OpenAI and Supabase calls are stubbed via monkeypatch so tests run
in milliseconds without any network dependency.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.rag import chat as chat_mod
from app.rag import memory as memory_mod
from app.rag.memory import ConversationMemory


# ─────────────────────────────────────────────────────────────────────────────
# Test doubles
# ─────────────────────────────────────────────────────────────────────────────


class _FakeChatCompletions:
    """Captures the messages each chat.completions.create call received
    and returns a canned response. Tests inspect ``calls`` to assert
    that memory context flowed where expected."""

    def __init__(self, response_text: str) -> None:
        self.response_text = response_text
        self.calls: list[list[dict[str, str]]] = []

    async def create(self, **kwargs: Any):
        self.calls.append(kwargs.get("messages") or [])

        class _Choice:
            def __init__(self, content: str) -> None:
                self.message = type("M", (), {"content": content})()

        class _Resp:
            def __init__(self, content: str) -> None:
                self.choices = [_Choice(content)]

        return _Resp(self.response_text)


class _FakeOpenAIClient:
    def __init__(self, response_text: str) -> None:
        self.chat = type(
            "C",
            (),
            {"completions": _FakeChatCompletions(response_text)},
        )()


class _FakeInsert:
    def __init__(self, sink: list[dict[str, Any]]) -> None:
        self._sink = sink
        self._row: dict[str, Any] | None = None

    def insert(self, row: dict[str, Any]):
        self._row = row
        return self

    def execute(self):
        if self._row is not None:
            self._sink.append(self._row)

        class _Resp:
            data = []

        return _Resp()


class _FakeRpc:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self.last_args: dict[str, Any] | None = None

    def __call__(self, _name: str, args: dict[str, Any]):
        self.last_args = args
        return self

    def execute(self):
        class _Resp:
            def __init__(self, data: list[dict[str, Any]]) -> None:
                self.data = data

        return _Resp(self._rows)


class _FakeDB:
    """Minimal Supabase double: only the two surfaces memory.py touches."""

    def __init__(
        self,
        *,
        match_rows: list[dict[str, Any]] | None = None,
    ) -> None:
        self.inserts: list[dict[str, Any]] = []
        self._fake_rpc = _FakeRpc(match_rows or [])

    def table(self, _name: str):
        return _FakeInsert(self.inserts)

    def rpc(self, name: str, args: dict[str, Any]):
        return self._fake_rpc(name, args)

    @property
    def last_rpc_args(self) -> dict[str, Any] | None:
        return self._fake_rpc.last_args


# ─────────────────────────────────────────────────────────────────────────────
# summarize_turn
# ─────────────────────────────────────────────────────────────────────────────


async def test_summarize_turn_returns_trimmed_clean_summary(monkeypatch) -> None:
    """The summarizer should strip leading bullets/quotes that the model
    occasionally emits despite the prompt — those would otherwise hurt
    the embedding's similarity to the next-turn query."""
    fake = _FakeOpenAIClient('"- Refund policy: 30-day window."')
    monkeypatch.setattr(memory_mod, "_client", lambda: fake)

    out = await memory_mod.summarize_turn(
        question="What's our refund policy?",
        answer="Returns within 30 days.",
        source_titles=["Refund SOP"],
    )

    assert out == "Refund policy: 30-day window."
    # The summarizer call must have included the source titles so the
    # produced summary mentions them and stays discoverable.
    msgs = fake.chat.completions.calls[0]
    assert any("Refund SOP" in m["content"] for m in msgs)


async def test_summarize_turn_returns_empty_on_blank_inputs(monkeypatch) -> None:
    """Defensive: if either side of the turn is empty there's nothing to
    remember and we must NOT call the model (cost / latency)."""
    fake = _FakeOpenAIClient("nope")
    monkeypatch.setattr(memory_mod, "_client", lambda: fake)

    assert await memory_mod.summarize_turn(question="", answer="x", source_titles=[]) == ""
    assert await memory_mod.summarize_turn(question="x", answer="", source_titles=[]) == ""
    assert fake.chat.completions.calls == []


async def test_summarize_turn_swallows_llm_errors(monkeypatch) -> None:
    """Memory summarization is best-effort. A model outage must NOT
    propagate to the chat pipeline — empty string means the caller
    skips writing the memory row."""

    class _BoomCompletions:
        async def create(self, **kwargs: Any):
            raise RuntimeError("openai down")

    class _BoomClient:
        chat = type("C", (), {"completions": _BoomCompletions()})()

    monkeypatch.setattr(memory_mod, "_client", lambda: _BoomClient())

    out = await memory_mod.summarize_turn(
        question="anything",
        answer="anything",
        source_titles=[],
    )
    assert out == ""


# ─────────────────────────────────────────────────────────────────────────────
# write_turn_memory
# ─────────────────────────────────────────────────────────────────────────────


async def test_write_turn_memory_persists_summary_with_embedding(monkeypatch) -> None:
    """End-to-end happy path: a successful turn produces one chat_memories
    row with the embedded summary, the source ids deduped, and the
    correct turn_index — so the next-turn lookup can find it."""
    fake_oai = _FakeOpenAIClient("Refund policy: 30-day window for damaged items.")
    monkeypatch.setattr(memory_mod, "_client", lambda: fake_oai)

    async def _fake_embed(texts):
        return [[0.42] * 1536 for _ in texts]

    monkeypatch.setattr(memory_mod, "embed_texts", _fake_embed)
    monkeypatch.setattr(memory_mod.settings, "memory_enabled", True)

    db = _FakeDB()
    citations = [
        {"source_id": "src-a", "title": "Refund SOP", "snippet": "..."},
        # Duplicate source_id — must be deduped on write.
        {"source_id": "src-a", "title": "Refund SOP", "snippet": "..."},
        {"source_id": "src-b", "title": "Care Manual", "snippet": "..."},
    ]

    await memory_mod.write_turn_memory(
        db,  # type: ignore[arg-type]
        user_id="u",
        conversation_id="conv-1",
        turn_index=2,
        question="What's our refund policy?",
        answer="Returns within 30 days.",
        citations=citations,
    )

    assert len(db.inserts) == 1
    row = db.inserts[0]
    assert row["user_id"] == "u"
    assert row["conversation_id"] == "conv-1"
    assert row["turn_index"] == 2
    assert "30-day" in row["summary"]
    assert len(row["embedding"]) == 1536
    # Source ids are deduped but order isn't guaranteed.
    assert set(row["source_ids"]) == {"src-a", "src-b"}


async def test_write_turn_memory_short_circuits_when_disabled(monkeypatch) -> None:
    """The `memory_enabled` flag must be a real kill switch: no LLM call,
    no embed call, no insert."""
    monkeypatch.setattr(memory_mod.settings, "memory_enabled", False)

    async def _boom_embed(_texts):
        raise AssertionError("embed must not run when memory is disabled")

    class _BoomCompletions:
        async def create(self, **kwargs: Any):
            raise AssertionError("LLM must not run when memory is disabled")

    class _BoomClient:
        chat = type("C", (), {"completions": _BoomCompletions()})()

    monkeypatch.setattr(memory_mod, "embed_texts", _boom_embed)
    monkeypatch.setattr(memory_mod, "_client", lambda: _BoomClient())

    db = _FakeDB()
    await memory_mod.write_turn_memory(
        db,  # type: ignore[arg-type]
        user_id="u",
        conversation_id="conv-1",
        turn_index=0,
        question="q",
        answer="a",
        citations=[],
    )
    assert db.inserts == []


# ─────────────────────────────────────────────────────────────────────────────
# retrieve_memories
# ─────────────────────────────────────────────────────────────────────────────


async def test_retrieve_memories_filters_below_min_similarity(monkeypatch) -> None:
    """Off-topic memories must be filtered out so they don't pollute the
    decomposer's "Recent context" block. We assert that only rows above
    the configured threshold survive AND that order is preserved."""

    async def _fake_embed(texts):
        return [[0.1] * 1536 for _ in texts]

    monkeypatch.setattr(memory_mod, "embed_texts", _fake_embed)
    monkeypatch.setattr(memory_mod.settings, "memory_enabled", True)

    db = _FakeDB(
        match_rows=[
            {
                "id": "m1",
                "turn_index": 1,
                "summary": "Discussed the Pro headphone model specs.",
                "importance": 0.5,
                "source_ids": ["s1"],
                "similarity": 0.82,
            },
            {
                "id": "m2",
                "turn_index": 0,
                "summary": "Off-topic chat about the weather.",
                "importance": 0.3,
                "source_ids": [],
                "similarity": 0.31,  # below default 0.6
            },
            {
                "id": "m3",
                "turn_index": 2,
                "summary": "Discussed Lite headphone model pricing.",
                "importance": 0.5,
                "source_ids": ["s2"],
                "similarity": 0.71,
            },
        ]
    )

    out = await memory_mod.retrieve_memories(
        db,  # type: ignore[arg-type]
        user_id="u",
        conversation_id="conv-1",
        query="warranty on those models",
        top_k=5,
    )

    ids = [m.id for m in out]
    assert ids == ["m1", "m3"]  # m2 dropped, order preserved
    # The RPC must have been called with conversation scope so cross-
    # conversation memories never leak into this lookup.
    assert db.last_rpc_args is not None
    assert db.last_rpc_args["conversation"] == "conv-1"
    assert db.last_rpc_args["owner_id"] == "u"


async def test_retrieve_memories_returns_empty_when_disabled(monkeypatch) -> None:
    monkeypatch.setattr(memory_mod.settings, "memory_enabled", False)

    async def _boom(_texts):
        raise AssertionError("embed must not run when memory is disabled")

    monkeypatch.setattr(memory_mod, "embed_texts", _boom)

    db = _FakeDB(match_rows=[{"id": "x", "similarity": 0.99}])
    assert (
        await memory_mod.retrieve_memories(
            db,  # type: ignore[arg-type]
            user_id="u",
            conversation_id="c",
            query="anything",
        )
        == []
    )


# ─────────────────────────────────────────────────────────────────────────────
# Integration: memory feeds the decomposer (the actual reviewer fix)
# ─────────────────────────────────────────────────────────────────────────────


async def test_decomposer_receives_memory_context(monkeypatch) -> None:
    """When prior-turn memories are passed to the decomposer, they must
    appear in the user message under a "Recent context" heading. Without
    that, a curt follow-up like "and what about pricing?" can't be split
    correctly across multiple sources — which is the exact failure mode
    the reviewer flagged."""
    fake_oai = _FakeOpenAIClient("What is the price of the Pro?\nWhat is the price of the Lite?")
    monkeypatch.setattr(chat_mod, "_client", lambda: fake_oai)

    memories = [
        ConversationMemory(
            id="m1",
            turn_index=0,
            summary="Compared the Pro and Lite headphone models on noise-cancellation and battery life (Pro Spec Sheet, Lite Spec Sheet).",
            similarity=0.9,
            importance=0.5,
            source_ids=["src-pro", "src-lite"],
        ),
    ]

    out = await chat_mod._decompose_query(
        "and what about pricing on those two?",
        memories=memories,
    )

    # The model's two-line response was parsed into two sub-queries.
    assert out == [
        "What is the price of the Pro?",
        "What is the price of the Lite?",
    ]
    # The decomposer's user payload must contain both the question and
    # the memory context — not just the question. This is the linchpin
    # of the cross-source improvement.
    sent_msgs = fake_oai.chat.completions.calls[0]
    user_msg = next(m for m in sent_msgs if m["role"] == "user")
    assert "Recent context:" in user_msg["content"]
    assert "Pro and Lite" in user_msg["content"]
    assert "and what about pricing on those two?" in user_msg["content"]


async def test_decomposer_skips_llm_when_no_memories_and_single_topic(
    monkeypatch,
) -> None:
    """The cost-saving shortcut for plainly single-topic questions must
    still trigger when no memory context is available. Without this
    invariant, every chat turn pays a decompose-call tax even when
    there's nothing to split."""

    class _BoomCompletions:
        async def create(self, **kwargs: Any):
            raise AssertionError("LLM must not run for a single-topic question")

    class _BoomClient:
        chat = type("C", (), {"completions": _BoomCompletions()})()

    monkeypatch.setattr(chat_mod, "_client", lambda: _BoomClient())

    out = await chat_mod._decompose_query("How does authentication work?", memories=None)
    assert out == ["How does authentication work?"]

"""End-to-end chat turn orchestration with streamed reasoning visibility.

The caller gets an async iterator of typed events:

    { "type": "thinking", "text": "..." }        # human-readable step
    { "type": "sources_considered",              # array of candidate sources
      "sources": [{...}] }
    { "type": "token", "text": "..." }           # answer chunk
    { "type": "citations", "citations": [...] }  # sources the answer referenced
    { "type": "done" }
    { "type": "error", "message": "..." }

This design lets the frontend render the thinking trace inside the response
bubble (e.g. an expandable accordion) rather than behind a loading spinner.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from openai import AsyncOpenAI
from supabase import Client

from ..core.config import settings
from ..core.logging import logger
from .memory import ConversationMemory, retrieve_memories
from .prompt import (
    ANSWER_SYSTEM,
    DECOMPOSE_SYSTEM,
    REWRITE_SYSTEM,
    build_context_block,
    build_memory_block,
)
from .retrieval import RetrievedChunk, retrieve_multi

_CITATION_RE = re.compile(r"\[S(\d+)\]")
_MAX_HISTORY_TURNS = 10
_MAX_SUBQUERIES = 3


@dataclass
class Turn:
    role: str
    content: str


@dataclass
class ChatResult:
    """Final, serialisable record of what the turn produced.

    The streaming orchestrator writes this into persistent storage after it
    finishes, so a reload reproduces the exact conversation the user saw.
    """

    answer: str = ""
    reasoning: list[dict[str, Any]] = field(default_factory=list)
    citations: list[dict[str, Any]] = field(default_factory=list)


def _client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=settings.openai_api_key)


async def _rewrite_query(history: list[Turn], question: str) -> str:
    """Collapse a follow-up into a self-contained search query."""
    if not history:
        return question

    client = _client()
    messages: list[dict[str, str]] = [{"role": "system", "content": REWRITE_SYSTEM}]
    for t in history[-_MAX_HISTORY_TURNS:]:
        messages.append({"role": t.role, "content": t.content})
    messages.append({"role": "user", "content": f"Rewrite this question: {question}"})

    resp = await client.chat.completions.create(
        model=settings.openai_chat_model,
        messages=messages,
        temperature=0,
        max_tokens=128,
    )
    return (resp.choices[0].message.content or question).strip() or question


async def _decompose_query(
    question: str,
    *,
    memories: list[ConversationMemory] | None = None,
) -> list[str]:
    """Split a compound question into 1-3 standalone sub-queries.

    Returns a list of length >= 1. If the model thinks the question is a
    single topic it returns one element (the original question). Heavy
    heuristic shortcut: if the input doesn't contain any of the obvious
    compound markers AND no memory context was passed, skip the LLM call
    entirely. We can't shortcut when we have memory context because that
    context might let the decomposer split a question whose surface
    looks single-topic but actually references multiple prior items
    ("and what's their pricing?" after a discussion of two products).
    """
    q = question.strip()
    if not q:
        return [q]

    has_memories = bool(memories)
    lowered = q.lower()
    compound_markers = (" and ", " also ", "; ", " vs ", " versus ", "compare ")
    looks_compound = any(m in lowered for m in compound_markers) or lowered.count(",") >= 2
    if not looks_compound and not has_memories:
        return [q]

    # When memories are available, append them to the user payload as a
    # "Recent context" block. The DECOMPOSE_SYSTEM prompt explicitly
    # restricts the model to using this only for resolving pronouns and
    # implicit references, never to invent topics.
    user_content = q
    if memories:
        memory_block = build_memory_block([m.summary for m in memories])
        if memory_block:
            user_content = f"{q}\n\nRecent context:\n{memory_block}"

    client = _client()
    try:
        resp = await client.chat.completions.create(
            model=settings.openai_chat_model,
            messages=[
                {"role": "system", "content": DECOMPOSE_SYSTEM},
                {"role": "user", "content": user_content},
            ],
            temperature=0,
            max_tokens=256,
        )
    except Exception:  # noqa: BLE001
        # Decomposition is an optimisation, not a hard requirement. If the
        # call fails, fall back to single-query retrieval rather than
        # bringing the whole turn down.
        logger.exception("chat.decompose_failed")
        return [q]

    raw = (resp.choices[0].message.content or "").strip()
    lines = [ln.strip(" -*\u2022\t") for ln in raw.splitlines() if ln.strip()]
    queries = [ln for ln in lines if ln][:_MAX_SUBQUERIES]
    return queries or [q]


def _summarize_sources(chunks: list[RetrievedChunk]) -> list[dict[str, Any]]:
    """Group retrieved chunks by source for display in the thinking trace."""
    by_source: dict[str, dict[str, Any]] = {}
    for c in chunks:
        entry = by_source.setdefault(
            c.source_id,
            {
                "source_id": c.source_id,
                "title": c.source_title,
                "type": c.source_type,
                "url": c.source_url,
                "chunk_count": 0,
                "top_similarity": 0.0,
            },
        )
        entry["chunk_count"] += 1
        entry["top_similarity"] = max(entry["top_similarity"], c.similarity)
    return sorted(by_source.values(), key=lambda s: s["top_similarity"], reverse=True)


def _extract_citations(
    answer: str, chunks: list[RetrievedChunk]
) -> list[dict[str, Any]]:
    """Map the inline ``[Sn]`` tags the model emitted back to real sources."""
    cited_indices = {int(m.group(1)) for m in _CITATION_RE.finditer(answer)}
    # Map tag index (1-based) → chunk. Dedupe by source, keeping the first hit.
    seen_sources: set[str] = set()
    out: list[dict[str, Any]] = []
    for idx in sorted(cited_indices):
        if 1 <= idx <= len(chunks):
            c = chunks[idx - 1]
            if c.source_id in seen_sources:
                continue
            seen_sources.add(c.source_id)
            out.append(
                {
                    "source_id": c.source_id,
                    # The chunk id is what the citation drawer needs to load
                    # the full chunk plus its immediate neighbours.
                    "chunk_id": c.id,
                    "title": c.source_title,
                    "type": c.source_type,
                    "url": c.source_url,
                    "snippet": c.content[:240].strip(),
                    "tag": f"S{idx}",
                }
            )
    return out


async def stream_chat_turn(
    db: Client,
    *,
    user_id: str,
    conversation_id: str | None = None,
    history: list[Turn],
    question: str,
    result: ChatResult,
) -> AsyncIterator[dict[str, Any]]:
    """Run a full turn and stream reasoning + answer events.

    `result` is mutated in place so the API layer can persist the final
    message after the stream completes (including if the client disconnects
    mid-stream, as the background task will finish on its own).

    ``conversation_id`` is optional so legacy callers / tests that don't
    care about long-term memory can keep working unchanged. When supplied,
    we run a per-conversation memory lookup after the rewrite step and
    feed the results to both the decomposer and the answer LLM, which is
    the mechanism behind the cross-source/follow-up improvements.
    """

    def record(event: dict[str, Any]) -> dict[str, Any]:
        # Mirror thinking events into the durable reasoning trail so refreshes
        # show what the user saw live.
        if event["type"] in {"thinking", "sources_considered"}:
            result.reasoning.append(event)
        return event

    try:
        yield record({"type": "thinking", "text": "Understanding your question…"})

        standalone = await _rewrite_query(history, question)
        if standalone.strip().lower() != question.strip().lower():
            yield record(
                {
                    "type": "thinking",
                    "text": f"Rewrote follow-up as: \u201c{standalone}\u201d",
                }
            )

        # Long-term memory lookup for this conversation. Runs after the
        # rewrite so the embedding query is already standalone, which is
        # what the memory fragments were summarized to match. Failures
        # inside retrieve_memories degrade silently to an empty list.
        memories: list[ConversationMemory] = []
        if conversation_id and settings.memory_enabled:
            memories = await retrieve_memories(
                db,
                user_id=user_id,
                conversation_id=conversation_id,
                query=standalone,
            )
            if memories:
                preview = "; ".join(
                    m.summary[:90] + ("…" if len(m.summary) > 90 else "")
                    for m in memories[:2]
                )
                yield record(
                    {
                        "type": "thinking",
                        "text": (
                            f"Recalled {len(memories)} earlier moment"
                            f"{'s' if len(memories) != 1 else ''} in this "
                            f"conversation: {preview}"
                        ),
                    }
                )

        sub_queries = await _decompose_query(standalone, memories=memories)
        if len(sub_queries) > 1:
            preview = ", ".join(f"\u201c{s}\u201d" for s in sub_queries)
            yield record(
                {
                    "type": "thinking",
                    "text": (
                        f"Splitting into {len(sub_queries)} sub-questions: {preview}"
                    ),
                }
            )

        yield record({"type": "thinking", "text": "Searching your knowledge base…"})

        chunks = await retrieve_multi(
            db,
            user_id=user_id,
            queries=sub_queries,
            top_k_per_query=settings.retrieval_top_k_per_query,
            final_top_k=settings.retrieval_final_top_k,
            max_per_source=settings.retrieval_max_per_source,
        )

        if not chunks:
            yield record(
                {
                    "type": "thinking",
                    "text": "Your knowledge base is empty or nothing matched this query.",
                }
            )
            msg = (
                "I couldn't find anything in your knowledge base that relates to "
                "that question. Try uploading a source and asking again."
            )
            result.answer = msg
            for ch in msg:
                yield {"type": "token", "text": ch}
            yield {"type": "citations", "citations": []}
            yield {"type": "done"}
            return

        sources = _summarize_sources(chunks)
        yield record({"type": "sources_considered", "sources": sources})
        titles = ", ".join(s["title"] for s in sources[:3])
        yield record(
            {
                "type": "thinking",
                "text": f"Reading {len(chunks)} passages across {len(sources)} source"
                f"{'s' if len(sources) != 1 else ''}: {titles}"
                + ("…" if len(sources) > 3 else "."),
            }
        )

        context = build_context_block(chunks)
        yield record({"type": "thinking", "text": "Composing a grounded answer…"})

        # The memory block goes BEFORE the source context so the model
        # treats it as continuity-only — never as a citable source. The
        # ANSWER_SYSTEM contract still requires every claim to be
        # grounded in [Sn] excerpts, which keeps the answer auditable.
        memory_block = build_memory_block([m.summary for m in memories])
        memory_section = (
            f"Recent context from this conversation (for continuity, not "
            f"citable):\n{memory_block}\n\n---\n\n"
            if memory_block
            else ""
        )

        user_content = (
            f"{memory_section}"
            "Context:\n"
            f"{context}\n\n"
            "---\n\n"
            f"Question: {question}"
        )

        messages: list[dict[str, str]] = [{"role": "system", "content": ANSWER_SYSTEM}]
        for t in history[-_MAX_HISTORY_TURNS:]:
            messages.append({"role": t.role, "content": t.content})
        messages.append({"role": "user", "content": user_content})

        client = _client()
        stream = await client.chat.completions.create(
            model=settings.openai_chat_model,
            messages=messages,
            temperature=0.2,
            stream=True,
        )

        answer_parts: list[str] = []
        async for event in stream:
            delta = event.choices[0].delta.content if event.choices else None
            if not delta:
                continue
            answer_parts.append(delta)
            yield {"type": "token", "text": delta}

        answer = "".join(answer_parts).strip()
        result.answer = answer
        result.citations = _extract_citations(answer, chunks)
        yield {"type": "citations", "citations": result.citations}
        yield {"type": "done"}

    except Exception as exc:  # noqa: BLE001
        logger.exception("chat.stream_failed")
        yield {"type": "error", "message": f"Something went wrong: {exc}"}

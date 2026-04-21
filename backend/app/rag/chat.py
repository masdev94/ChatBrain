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
from .prompt import ANSWER_SYSTEM, REWRITE_SYSTEM, build_context_block
from .retrieval import RetrievedChunk, retrieve

_CITATION_RE = re.compile(r"\[S(\d+)\]")
_MAX_HISTORY_TURNS = 10


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
    history: list[Turn],
    question: str,
    result: ChatResult,
) -> AsyncIterator[dict[str, Any]]:
    """Run a full turn and stream reasoning + answer events.

    `result` is mutated in place so the API layer can persist the final
    message after the stream completes (including if the client disconnects
    mid-stream, as the background task will finish on its own).
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

        yield record({"type": "thinking", "text": "Searching your knowledge base…"})

        chunks = await retrieve(
            db,
            user_id=user_id,
            query=standalone,
            top_k=settings.retrieval_top_k,
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

        user_content = (
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

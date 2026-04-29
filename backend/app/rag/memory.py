"""Long-term memory for the chat orchestrator.

Inspired by the agent-memory pattern in DB-GPT's docs ("long-term memory
resembles the external vector storage that agents can rapidly query and
retrieve from as needed"). Translated to ChatBrain:

* After each completed turn, we compress the user's question + assistant's
  answer into a single short, embedding-friendly line (the "memory
  fragment") via :func:`summarize_turn`.
* That fragment is embedded and stored in the ``chat_memories`` table
  scoped to ``(user_id, conversation_id, turn_index)``.
* When a new turn arrives, :func:`retrieve_memories` runs a vector search
  over the memories of *this conversation* and surfaces the most relevant
  fragments, which the chat orchestrator feeds to the decomposer and to
  the answer LLM.

Why this directly addresses the cross-source / compound-question failure
mode the reviewer flagged:

* The decomposer can resolve pronouns and implicit referents ("those two",
  "the second one") because the memory layer surfaces what was actually
  discussed earlier, not just the literal previous turn's text.
* The answerer gets a continuity hint that prevents the "starts from
  scratch every turn" behaviour, which is what makes multi-source
  follow-ups feel disconnected today.
* The persisted ``source_ids`` act as a soft source-prior: the chat
  orchestrator can use them to bias chunk retrieval toward previously
  useful sources without hard-filtering anything out.
"""

from __future__ import annotations

from dataclasses import dataclass

from openai import AsyncOpenAI
from supabase import Client

from ..core.config import settings
from ..core.logging import logger
from ..ingestion.embedder import embed_texts
from .prompt import MEMORIZE_SYSTEM


# Cap to keep summarization cheap and predictable. The MEMORIZE_SYSTEM
# prompt asks for at most 30 words; we hard-cap output here as a defense
# against an unusually verbose model response.
_MAX_SUMMARY_CHARS = 320

# How much of the answer + question we feed to the summarizer. The
# summarizer is a cheap model so we can afford a generous slice, but
# trimming keeps token cost predictable and avoids leaking entire
# multi-paragraph answers into the summary by accident.
_SUMMARIZE_QUESTION_CLIP = 600
_SUMMARIZE_ANSWER_CLIP = 1500


@dataclass
class ConversationMemory:
    """A single retrieved memory fragment.

    ``source_ids`` is the list of source ids that the originating turn
    cited; the chat orchestrator can use it as a soft retrieval prior.
    """

    id: str
    turn_index: int
    summary: str
    similarity: float
    importance: float
    source_ids: list[str]


def _client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=settings.openai_api_key)


async def summarize_turn(
    *,
    question: str,
    answer: str,
    source_titles: list[str],
) -> str:
    """Compress one turn into a single short retrieval-friendly line.

    Returns the empty string on failure rather than raising — memory
    summarization is best-effort and must never bring down the chat
    pipeline. The chat orchestrator treats an empty summary as "skip
    this memory write".
    """
    q = (question or "").strip()
    a = (answer or "").strip()
    if not q or not a:
        return ""

    # Build the user payload. Including the cited sources by title in the
    # prompt encourages the model to mention them in the summary, which
    # makes the memory more discoverable when the user asks about the
    # same topic again later.
    sources_line = ", ".join(t for t in source_titles if t.strip()) or "(none)"
    user = (
        f"Question: {q[:_SUMMARIZE_QUESTION_CLIP]}\n"
        f"Answer: {a[:_SUMMARIZE_ANSWER_CLIP]}\n"
        f"Sources: {sources_line}"
    )

    try:
        resp = await _client().chat.completions.create(
            model=settings.openai_chat_model,
            messages=[
                {"role": "system", "content": MEMORIZE_SYSTEM},
                {"role": "user", "content": user},
            ],
            temperature=0,
            max_tokens=120,
        )
    except Exception:  # noqa: BLE001
        # Non-fatal: a missing memory just means slightly weaker
        # context next turn. The user still got their answer.
        logger.exception("memory.summarize_failed")
        return ""

    text = (resp.choices[0].message.content or "").strip()
    # Strip markdown bullets / quoting that the model occasionally adds
    # despite the prompt, so the embedding lands on the topic itself.
    while text and text[0] in {"-", "*", "•", '"', "'"}:
        text = text[1:].lstrip()
    while text and text[-1] in {'"', "'"}:
        text = text[:-1].rstrip()
    return text[:_MAX_SUMMARY_CHARS]


async def write_turn_memory(
    db: Client,
    *,
    user_id: str,
    conversation_id: str,
    turn_index: int,
    question: str,
    answer: str,
    citations: list[dict],
    importance: float = 0.5,
) -> None:
    """Generate, embed, and persist a memory fragment for one turn.

    Wired up to run as a FastAPI background task after the assistant
    message is persisted, so it never blocks the user's stream. Failures
    are logged but never propagated — long-term memory is a quality
    feature, not a correctness one.
    """
    if not settings.memory_enabled:
        return
    if not (question or "").strip() or not (answer or "").strip():
        return

    source_titles = [c.get("title", "") for c in (citations or []) if c.get("title")]
    source_ids = list({c["source_id"] for c in (citations or []) if c.get("source_id")})

    try:
        summary = await summarize_turn(
            question=question, answer=answer, source_titles=source_titles
        )
        if not summary:
            return

        [vector] = await embed_texts([summary])

        db.table("chat_memories").insert(
            {
                "user_id": user_id,
                "conversation_id": conversation_id,
                "turn_index": turn_index,
                "summary": summary,
                "embedding": vector,
                "importance": float(importance),
                "source_ids": source_ids,
            }
        ).execute()
    except Exception:  # noqa: BLE001
        logger.exception(
            "memory.write_failed",
            conversation_id=conversation_id,
            turn_index=turn_index,
        )


async def retrieve_memories(
    db: Client,
    *,
    user_id: str,
    conversation_id: str,
    query: str,
    top_k: int | None = None,
    min_similarity: float | None = None,
) -> list[ConversationMemory]:
    """Fetch the most relevant memory fragments for ``query`` scoped to
    this user + conversation. Empty list is returned (rather than
    raising) on any failure so the chat pipeline degrades to a
    memory-less turn instead of erroring out.
    """
    if not settings.memory_enabled:
        return []
    q = (query or "").strip()
    if not q:
        return []

    k = top_k if top_k is not None else settings.memory_top_k
    min_sim = (
        min_similarity if min_similarity is not None else settings.memory_min_similarity
    )

    try:
        [vector] = await embed_texts([q])
        resp = db.rpc(
            "match_memories",
            {
                "query_embedding": vector,
                "conversation": conversation_id,
                # Ask for a few extra rows so the post-fetch
                # similarity threshold doesn't starve us.
                "match_count": max(k * 2, k),
                "owner_id": user_id,
            },
        ).execute()
    except Exception:  # noqa: BLE001
        logger.exception("memory.retrieve_failed")
        return []

    rows = resp.data or []
    out: list[ConversationMemory] = []
    for row in rows:
        sim = float(row.get("similarity") or 0.0)
        if sim < min_sim:
            continue
        out.append(
            ConversationMemory(
                id=row["id"],
                turn_index=int(row.get("turn_index") or 0),
                summary=row.get("summary") or "",
                similarity=sim,
                importance=float(row.get("importance") or 0.0),
                source_ids=list(row.get("source_ids") or []),
            )
        )
        if len(out) >= k:
            break
    return out


def collect_memory_source_priors(memories: list[ConversationMemory]) -> set[str]:
    """Return the union of source ids referenced by the supplied
    memories. The chat orchestrator uses this set as a soft retrieval
    prior — chunks from these sources keep their natural rank but the
    diversity cap can be relaxed against them, since prior turns
    already showed they're useful for this conversation."""
    out: set[str] = set()
    for m in memories:
        for sid in m.source_ids:
            if sid:
                out.add(sid)
    return out

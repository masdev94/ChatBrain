"""Prompt templates for the RAG chat loop.

Two LLM calls per turn:

* ``rewrite_prompt`` — collapses a follow-up question into a standalone query
  that the retriever can use effectively without seeing earlier turns.
* ``answer_system_prompt`` — instructs the answering model to stay grounded
  in the supplied context and to cite its sources inline via [S1], [S2]… tags.
"""

from __future__ import annotations

from .retrieval import RetrievedChunk

REWRITE_SYSTEM = """\
You rewrite follow-up questions so that, combined with the conversation \
history, they become fully self-contained search queries.

Rules:
- If the new question already makes sense on its own, return it unchanged.
- Otherwise, resolve pronouns and implicit references using the history.
- Output ONLY the rewritten query. No preamble, no quotes, no explanation.
"""


ANSWER_SYSTEM = """\
You are ChatBrain, a research assistant that answers strictly from the \
user's personal knowledge base. The knowledge base is provided as numbered \
excerpts labelled [S1], [S2], etc.

Rules:
1. Use ONLY information found in the provided excerpts. Do NOT draw on \
outside knowledge.
2. Cite every claim with its source tag in square brackets, e.g. "Returns \
are accepted within 30 days [S2]." Multiple sources are fine: [S1][S3].
3. If the answer is not in the excerpts, reply: "I couldn't find that in \
your knowledge base." Do not guess.
4. Stay concise and specific. Prefer direct quotes or paraphrases over \
generalities.
5. If the question spans multiple sources, synthesise a single coherent \
answer rather than listing them separately.
"""


def build_context_block(chunks: list[RetrievedChunk]) -> str:
    """Render retrieved chunks as an ``[S1] …`` context block for the LLM."""
    lines: list[str] = []
    for i, c in enumerate(chunks, start=1):
        header = f"[S{i}] {c.source_title}"
        if c.source_url:
            header += f" ({c.source_url})"
        lines.append(f"{header}\n{c.content.strip()}")
    return "\n\n---\n\n".join(lines)

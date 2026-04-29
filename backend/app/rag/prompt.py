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


# ─────────────────────────────────────────────────────────────────────────────
# Long-term memory (per-conversation vector store of past turn summaries).
#
# After each completed turn we ask gpt-4o-mini to compress the user's
# question + assistant's answer into a single, embedding-friendly line:
#
#     "Discussed <topic>; cited <sources>; key points: <gist>."
#
# Short, factual, in past tense — easy for the retriever to match against
# the user's new query. We deliberately skip filler phrasing ("the user
# asked") so the embedding lands close to the topic vector, not the
# meta-shape of a Q&A.
# ─────────────────────────────────────────────────────────────────────────────
MEMORIZE_SYSTEM = """\
You compress one turn of a chat into a single short line that an \
embedding-similarity retriever can later match against new questions.

Rules:
- One line, at most 30 words.
- Past tense. Factual. No filler ("the user asked", "I responded").
- Mention the concrete topic + key claims, not the conversational shape.
- If specific named sources were cited, list them in parentheses.
- No leading/trailing punctuation other than the final period.

Examples:

Input:
Question: What's our refund policy?
Answer: Returns are accepted within 30 days for damaged items; refunds \
issue to the original payment method [S1][S2].
Sources: Refund SOP, Customer Care Manual

Output:
Refund policy: 30-day return window for damaged items; refunds to original \
payment method (Refund SOP, Customer Care Manual).

Input:
Question: How do I cancel a subscription?
Answer: Sign in, open Billing, click Cancel. Cancellation takes effect at \
the end of the current period [S3].
Sources: Cancel SOP

Output:
Subscription cancellation flow: Billing > Cancel; takes effect at end of \
current period (Cancel SOP).
"""


DECOMPOSE_SYSTEM = """\
You split compound questions into independent search queries so a retrieval \
system can find the right passages for each part separately.

Rules:
- If the input is a single question covering one topic, output it unchanged \
on a single line.
- If the input bundles two or three independent questions (joined by "and", \
"also", commas, or "compare X vs Y"), output each as its own self-contained \
query, one per line.
- Output AT MOST 3 queries.
- Each output line must be a complete, standalone question or query.
- If "Recent context" is provided, use it ONLY to resolve pronouns or \
implicit references in the input ("those two", "the second one"). Do NOT \
invent topics that aren't in the input.
- Output ONLY the queries, one per line. No numbering, no preamble, no \
explanation, no quotes.

Examples:
Input: "What's our refund policy and how do I cancel a subscription?"
Output:
What is our refund policy?
How do I cancel a subscription?

Input: "Compare the warranty on the Pro and the Lite models"
Output:
What is the warranty on the Pro model?
What is the warranty on the Lite model?

Input: "How does authentication work?"
Output:
How does authentication work?

Input: "and what's the warranty on those two?"
Recent context:
- Compared the Pro and Lite headphone models on noise-cancellation and \
battery life (Pro Spec Sheet, Lite Spec Sheet).
Output:
What is the warranty on the Pro model?
What is the warranty on the Lite model?
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


def build_memory_block(summaries: list[str]) -> str:
    """Render long-term memory fragments as a bullet list for prompts that
    consume them (decomposer + answerer). Empty input returns ``""`` so
    callers can branch on truthiness without a length check."""
    if not summaries:
        return ""
    return "\n".join(f"- {s.strip()}" for s in summaries if s and s.strip())

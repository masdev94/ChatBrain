"""Source summarization.

Generates a short, neutral 1–2 sentence summary of the ingested text so the
frontend can show "what is this source about?" inside each card without the
user having to open the document.

The summary is best-effort: failures are logged and produce an empty string,
which lets the ingestion pipeline still mark the source as ``ready``.
"""

from __future__ import annotations

from openai import AsyncOpenAI
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from ..core.config import settings
from ..core.logging import logger

_MAX_INPUT_CHARS = 6000  # ~1.5k tokens — enough context, cheap to send
_MAX_OUTPUT_TOKENS = 120

_SYSTEM = (
    "You write tight, neutral summaries of arbitrary documents so a reader "
    "can decide whether the source is relevant to their question.\n"
    "Rules:\n"
    "• Reply with 1–2 sentences, max ~40 words total.\n"
    "• Describe what the source IS about — no preamble like \"This document\".\n"
    "• Do not invent facts; if the excerpt is too thin, say so briefly.\n"
    "• Plain text. No markdown, no bullets, no quotes."
)


def _client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=settings.openai_api_key)


async def summarize_text(text: str) -> str:
    """Return a short summary of `text`. Empty string on any failure."""
    excerpt = (text or "").strip()
    if not excerpt:
        return ""
    if len(excerpt) > _MAX_INPUT_CHARS:
        excerpt = excerpt[:_MAX_INPUT_CHARS]

    client = _client()

    try:
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(3),
            wait=wait_exponential(multiplier=0.4, min=0.4, max=4),
            retry=retry_if_exception_type(Exception),
            reraise=True,
        ):
            with attempt:
                resp = await client.chat.completions.create(
                    model=settings.openai_chat_model,
                    messages=[
                        {"role": "system", "content": _SYSTEM},
                        {
                            "role": "user",
                            "content": f"Summarize this source:\n\n{excerpt}",
                        },
                    ],
                    temperature=0.2,
                    max_tokens=_MAX_OUTPUT_TOKENS,
                )
                summary = (resp.choices[0].message.content or "").strip()
                # Trim wrapping quotes the model sometimes adds despite the rule.
                if len(summary) >= 2 and summary[0] in {'"', "'"} and summary[-1] == summary[0]:
                    summary = summary[1:-1].strip()
                return summary
    except Exception as exc:  # noqa: BLE001 - summary is best-effort
        logger.warning("summarize.failed", error=str(exc))
        return ""

    return ""

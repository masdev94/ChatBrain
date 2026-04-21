"""Embeddings.

Batches inputs to stay well below OpenAI's per-request token ceiling and
retries on transient errors. Returns a list aligned positionally with the
input.
"""

from __future__ import annotations

from typing import Sequence

from openai import AsyncOpenAI
from tenacity import AsyncRetrying, retry_if_exception_type, stop_after_attempt, wait_exponential

from ..core.config import settings

_MAX_BATCH = 96  # conservative: well under OpenAI's 2048-item / 300k-token ceiling


def _client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=settings.openai_api_key)


async def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    """Embed `texts` preserving order. Empty strings are replaced with a
    single space so OpenAI doesn't 400 on zero-length inputs."""
    cleaned = [t if t.strip() else " " for t in texts]

    client = _client()
    out: list[list[float]] = []

    for start in range(0, len(cleaned), _MAX_BATCH):
        batch = cleaned[start : start + _MAX_BATCH]
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(4),
            wait=wait_exponential(multiplier=0.5, min=0.5, max=8),
            retry=retry_if_exception_type(Exception),
            reraise=True,
        ):
            with attempt:
                resp = await client.embeddings.create(
                    model=settings.openai_embedding_model,
                    input=list(batch),
                )
                out.extend(item.embedding for item in resp.data)

    return out

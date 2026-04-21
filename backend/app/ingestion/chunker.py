"""Token-aware recursive chunker.

Strategy:
    1. Split on strong paragraph boundaries first (double newlines).
    2. If a paragraph is still larger than the target token budget, recurse on
       progressively weaker boundaries (single newline → sentence → word).
    3. Pack the resulting atoms greedily into chunks of ~`target_tokens`,
       carrying `overlap_tokens` from the previous chunk into the next so a
       question that spans a boundary still has local context.

This keeps chunks semantically whole while staying within the embedding
model's effective context and giving the retriever clean boundaries.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

import tiktoken

# text-embedding-3-small uses cl100k_base. We cache the encoder so we aren't
# re-instantiating it for every chunk.
@lru_cache(maxsize=1)
def _encoder() -> tiktoken.Encoding:
    return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    return len(_encoder().encode(text))


@dataclass(frozen=True)
class Chunk:
    index: int
    content: str
    token_count: int


# Ordered from strongest to weakest boundary. When a block still exceeds the
# budget at the bottom of this list (pathological input with no whitespace)
# we fall back to a hard character cut.
_SEPARATORS: tuple[str, ...] = ("\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ")


def _split_by(text: str, separator: str) -> list[str]:
    if separator == "":
        return list(text)
    parts = text.split(separator)
    # Reattach the separator to every part except the last to preserve text.
    out: list[str] = []
    for i, p in enumerate(parts):
        if not p:
            continue
        out.append(p + (separator if i < len(parts) - 1 else ""))
    return out


def _atomize(text: str, max_tokens: int) -> list[str]:
    """Break text into pieces each <= max_tokens, respecting boundaries."""
    text = text.strip()
    if not text:
        return []
    if count_tokens(text) <= max_tokens:
        return [text]

    for sep in _SEPARATORS:
        parts = _split_by(text, sep)
        if len(parts) > 1:
            out: list[str] = []
            for p in parts:
                if count_tokens(p) <= max_tokens:
                    out.append(p)
                else:
                    out.extend(_atomize(p, max_tokens))
            return out

    # No boundary found; hard-cut by tokens.
    enc = _encoder()
    ids = enc.encode(text)
    out = []
    for i in range(0, len(ids), max_tokens):
        out.append(enc.decode(ids[i : i + max_tokens]))
    return out


def _tail_tokens(text: str, n: int) -> str:
    if n <= 0 or not text:
        return ""
    enc = _encoder()
    ids = enc.encode(text)
    if len(ids) <= n:
        return text
    return enc.decode(ids[-n:])


def chunk_text(
    text: str,
    *,
    target_tokens: int = 800,
    overlap_tokens: int = 150,
) -> list[Chunk]:
    """Split `text` into overlap-aware chunks."""
    text = _normalize(text)
    if not text:
        return []

    atoms = _atomize(text, target_tokens)

    chunks: list[Chunk] = []
    buffer = ""
    buffer_tokens = 0

    for atom in atoms:
        atom_tokens = count_tokens(atom)
        if buffer_tokens + atom_tokens <= target_tokens:
            buffer += atom
            buffer_tokens += atom_tokens
            continue

        if buffer:
            chunks.append(
                Chunk(
                    index=len(chunks),
                    content=buffer.strip(),
                    token_count=buffer_tokens,
                )
            )
            carry = _tail_tokens(buffer, overlap_tokens)
            buffer = carry + ("\n" if carry and not carry.endswith("\n") else "") + atom
            buffer_tokens = count_tokens(buffer)
        else:
            buffer = atom
            buffer_tokens = atom_tokens

    if buffer.strip():
        chunks.append(
            Chunk(
                index=len(chunks),
                content=buffer.strip(),
                token_count=buffer_tokens,
            )
        )

    return chunks


_WS_RE = re.compile(r"[ \t]+")
_EOL_RE = re.compile(r"\r\n?")
_MULTI_BLANK_RE = re.compile(r"\n{3,}")


def _normalize(text: str) -> str:
    """Collapse obnoxious whitespace but keep paragraph structure intact."""
    text = _EOL_RE.sub("\n", text)
    text = _WS_RE.sub(" ", text)
    text = _MULTI_BLANK_RE.sub("\n\n", text)
    return text.strip()

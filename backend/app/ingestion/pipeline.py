"""Source → chunks → embeddings orchestration.

Each pipeline function is invoked by the API layer as a FastAPI background
task. They own the lifecycle of a source row:

    pending → processing → ready     (happy path)
    pending → processing → failed    (with `error` populated)

We use the service-role client here because we're running detached from the
originating request and need to sidestep RLS — the owning `user_id` is
always carried explicitly on every insert.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from supabase import Client

from ..core.logging import logger
from .chunker import chunk_text
from .embedder import embed_texts
from .pdf import PdfExtractionError, extract_pdf
from .url import UrlScrapeError, scrape_url

Loader = Callable[[dict[str, Any], dict[str, str]], Awaitable[str]]


async def ingest_text(
    db: Client,
    *,
    source_id: str,
    user_id: str,
    text: str,
    target_tokens: int,
    overlap_tokens: int,
) -> None:
    """Chunk + embed a pasted-text source."""

    async def loader(meta: dict[str, Any], _title: dict[str, str]) -> str:
        meta["char_count"] = len(text)
        meta["extracted_via"] = "paste"
        return text

    await _run(
        db,
        source_id=source_id,
        user_id=user_id,
        loader=loader,
        target_tokens=target_tokens,
        overlap_tokens=overlap_tokens,
    )


async def ingest_pdf(
    db: Client,
    *,
    source_id: str,
    user_id: str,
    pdf_bytes: bytes,
    target_tokens: int,
    overlap_tokens: int,
) -> None:
    """Extract text from a PDF (with OCR fallback), then chunk + embed."""

    async def loader(meta: dict[str, Any], _title: dict[str, str]) -> str:
        result = await extract_pdf(pdf_bytes)
        meta.update(
            {
                "page_count": result.page_count,
                "ocr_pages": result.ocr_pages,
                "char_count": len(result.text),
                "extracted_via": "pymupdf+vision-ocr" if result.ocr_pages else "pymupdf",
            }
        )
        return result.text

    await _run(
        db,
        source_id=source_id,
        user_id=user_id,
        loader=loader,
        target_tokens=target_tokens,
        overlap_tokens=overlap_tokens,
        known_errors=(PdfExtractionError,),
    )


async def ingest_url(
    db: Client,
    *,
    source_id: str,
    user_id: str,
    url: str,
    target_tokens: int,
    overlap_tokens: int,
) -> None:
    """Scrape a URL, then chunk + embed."""

    async def loader(meta: dict[str, Any], title: dict[str, str]) -> str:
        result = await scrape_url(url)
        meta.update(
            {
                "domain": result.domain,
                "char_count": result.char_count,
                "extracted_via": "trafilatura",
            }
        )
        if result.title:
            title["title"] = result.title
        return result.text

    await _run(
        db,
        source_id=source_id,
        user_id=user_id,
        loader=loader,
        target_tokens=target_tokens,
        overlap_tokens=overlap_tokens,
        known_errors=(UrlScrapeError,),
    )


# ──────────────────────────────────────────────────────────────────────────
# Shared orchestration
# ──────────────────────────────────────────────────────────────────────────
async def _run(
    db: Client,
    *,
    source_id: str,
    user_id: str,
    loader: Loader,
    target_tokens: int,
    overlap_tokens: int,
    known_errors: tuple[type[Exception], ...] = (),
) -> None:
    log = logger.bind(source_id=source_id, user_id=user_id)
    log.info("ingest.start")

    metadata: dict[str, Any] = {}
    title_override: dict[str, str] = {}

    try:
        db.table("sources").update({"status": "processing"}).eq("id", source_id).execute()

        text = await loader(metadata, title_override)

        chunks = chunk_text(
            text,
            target_tokens=target_tokens,
            overlap_tokens=overlap_tokens,
        )
        if not chunks:
            raise RuntimeError("Source produced zero chunks after processing.")

        log.info("ingest.embedding", chunks=len(chunks))
        vectors = await embed_texts([c.content for c in chunks])

        rows = [
            {
                "source_id": source_id,
                "user_id": user_id,
                "chunk_index": c.index,
                "content": c.content,
                "token_count": c.token_count,
                "embedding": v,
            }
            for c, v in zip(chunks, vectors, strict=True)
        ]
        # Wipe any prior chunks (e.g. if we ever re-run ingestion) then insert fresh.
        db.table("chunks").delete().eq("source_id", source_id).execute()
        db.table("chunks").insert(rows).execute()

        update: dict[str, Any] = {
            "status": "ready",
            "error": None,
            "chunk_count": len(chunks),
            "metadata": metadata,
        }
        if title_override:
            update.update(title_override)
        db.table("sources").update(update).eq("id", source_id).execute()
        log.info("ingest.ready", chunks=len(chunks))

    except known_errors as exc:
        log.warning("ingest.failed_known", error=str(exc))
        _mark_failed(db, source_id, str(exc))
    except Exception as exc:  # noqa: BLE001
        log.exception("ingest.failed_unexpected")
        _mark_failed(db, source_id, f"Unexpected error: {exc}")


def _mark_failed(db: Client, source_id: str, message: str) -> None:
    db.table("sources").update(
        {"status": "failed", "error": message[:500]}
    ).eq("id", source_id).execute()

"""PDF extractor failure modes we commit to handling."""

from __future__ import annotations

import pytest

from app.ingestion.pdf import PdfExtractionError, extract_pdf


async def test_non_pdf_bytes_raise_clear_error() -> None:
    with pytest.raises(PdfExtractionError):
        await extract_pdf(b"this is definitely not a PDF")


async def test_empty_bytes_raise() -> None:
    with pytest.raises(PdfExtractionError):
        await extract_pdf(b"")

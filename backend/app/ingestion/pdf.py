"""PDF extraction with OCR fallback for scanned pages.

Primary path uses PyMuPDF to pull native text. If a page yields essentially
no text (common for scanned documents) we render it to PNG and send it to
an OpenAI vision model for OCR. This avoids a Tesseract system dependency
and keeps the dev setup to a single `pip install`.

Failure modes handled:
    * Corrupt / non-PDF bytes → ``PdfExtractionError``.
    * Fully empty document → ``PdfExtractionError``.
    * Per-page OCR failure → that page is skipped; other pages still count.
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass

import pymupdf  # type: ignore[import-not-found]
from openai import AsyncOpenAI

from ..core.config import settings

MIN_CHARS_FOR_NATIVE = 30  # below this we consider the page "probably scanned"


class PdfExtractionError(RuntimeError):
    """Raised when a PDF cannot be turned into useful text."""


@dataclass
class PdfResult:
    text: str
    page_count: int
    ocr_pages: int  # how many pages fell back to vision OCR


async def extract_pdf(data: bytes) -> PdfResult:
    """Return plain text extracted from the PDF bytes.

    Each page is prefixed with ``[Page N]`` so the chunker can preserve page
    provenance in the surrounding context.
    """
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # pymupdf raises various exception types
        raise PdfExtractionError(f"Could not open PDF: {exc}") from exc

    if doc.page_count == 0:
        raise PdfExtractionError("PDF has no pages")

    page_texts: list[str] = []
    ocr_pages = 0
    client: AsyncOpenAI | None = None

    try:
        for i, page in enumerate(doc, start=1):
            raw = (page.get_text("text") or "").strip()
            if len(raw) >= MIN_CHARS_FOR_NATIVE:
                page_texts.append(f"[Page {i}]\n{raw}")
                continue

            # Fall back to vision OCR for scanned / image-only pages.
            if client is None:
                client = AsyncOpenAI(api_key=settings.openai_api_key)

            try:
                ocr_text = await _vision_ocr(page, client)
            except Exception:  # noqa: BLE001
                ocr_text = ""

            if ocr_text:
                ocr_pages += 1
                page_texts.append(f"[Page {i}]\n{ocr_text}")
            elif raw:
                page_texts.append(f"[Page {i}]\n{raw}")
            # else: skip blank page silently
    finally:
        doc.close()

    combined = "\n\n".join(page_texts).strip()
    if not combined:
        raise PdfExtractionError(
            "No text could be extracted from the PDF (empty or OCR failed on every page)."
        )

    return PdfResult(text=combined, page_count=doc.page_count, ocr_pages=ocr_pages)


async def _vision_ocr(page: "pymupdf.Page", client: AsyncOpenAI) -> str:
    """Render a page to PNG and ask the vision model to transcribe it verbatim."""
    # 2x zoom ≈ 144 DPI — a good readability/cost trade-off for typical scans.
    pix = page.get_pixmap(matrix=pymupdf.Matrix(2, 2))
    buf = io.BytesIO(pix.tobytes("png"))
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    resp = await client.chat.completions.create(
        model=settings.openai_vision_model,
        messages=[
            {
                "role": "system",
                "content": (
                    "You transcribe scanned documents. Return only the verbatim text "
                    "of the page, preserving paragraph breaks. Do not summarise, "
                    "translate, or add commentary. If the page is blank, return an "
                    "empty string."
                ),
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Transcribe this page:"},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{b64}"},
                    },
                ],
            },
        ],
        temperature=0,
    )

    return (resp.choices[0].message.content or "").strip()

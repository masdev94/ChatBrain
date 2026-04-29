"""URL scraping with a headless-browser fallback that actually copes with
real-world product pages.

Two-stage pipeline:

1. **Static path** — ``httpx`` fetch + the layered extractor below. Fast
   (~1s typical) and covers the majority of well-built content sites.
2. **Rendered fallback** — when the static path returns no usable
   content (or the site blocks the bare User-Agent with a 403), we
   relaunch the URL inside a headless Chromium via Playwright, give the
   page a real chance to settle its JS, and run the same layered
   extractor on the rendered HTML.

Why a *layered* extractor: trafilatura is excellent for blog/news/docs
pages but its article-detection heuristics reject most product pages
even after they're fully rendered. Real product pages put the goods in
JSON-LD blocks, OpenGraph metadata, and dense ``<main>`` markup that
doesn't look like an article. So we cascade through three strategies
and take the first one that yields enough text:

* **Layer 1** — trafilatura with ``favor_precision`` (best for articles).
* **Layer 2** — trafilatura with ``favor_recall`` (looser; catches docs
  pages with mixed content).
* **Layer 3** — JSON-LD / OpenGraph / cleaned ``<body>`` text via lxml.
  This is what saves us on product pages.

The fallback is gated by ``settings.playwright_enabled`` so envs without
Chromium (CI, slim Docker images) can opt out cleanly. We treat *401*,
*404*, and *410* as terminal — there's nothing a renderer can do — but
*403* and empty extractions are recoverable, since a real browser with
proper headers often clears anti-bot challenges.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx
import trafilatura

from ..core.config import settings
from ..core.logging import logger

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15 ChatBrain/0.1"
)

# Below this we treat extraction as "failed" and try the next layer (or
# fall back to a real browser if we haven't already).
MIN_CHARS = 200
# Body text that's shorter than this isn't worth appending in the
# last-resort layer — almost always nav/breadcrumb noise.
BODY_TEXT_MIN = 200
# Cap on the structured-data + body text we keep so a giant DOM doesn't
# inflate the document past the chunker's comfort zone.
RAW_TEXT_CAP = 200_000


class UrlScrapeError(RuntimeError):
    """Raised with a human-readable reason when we can't scrape a URL."""


@dataclass
class UrlResult:
    text: str
    title: str | None
    url: str
    char_count: int
    domain: str
    rendered: bool = False  # True iff the headless fallback produced this result


# ────────────────────────────────────────────────────────────────────────────
# Layered extraction
# ────────────────────────────────────────────────────────────────────────────


def _parse_extraction(extracted: str | None) -> tuple[str, str | None]:
    """Pull text + title out of trafilatura's JSON output. Empty / missing
    inputs return ('', None) so callers can branch on length."""
    if not extracted:
        return "", None
    try:
        data = json.loads(extracted)
    except (ValueError, TypeError):
        return "", None
    text = (data.get("text") or "").strip()
    title = (data.get("title") or "").strip() or None
    return text, title


def _extract_with_trafilatura(
    html: str,
    url: str,
    *,
    favor_precision: bool,
    favor_recall: bool = False,
) -> tuple[str, str | None]:
    extracted = trafilatura.extract(
        html,
        output_format="json",
        include_comments=False,
        include_tables=True,
        favor_precision=favor_precision,
        favor_recall=favor_recall,
        with_metadata=True,
        url=url,
    )
    return _parse_extraction(extracted)


def _iter_jsonld(data: Any) -> Iterator[dict[str, Any]]:
    """Yield each dict in a JSON-LD payload, recursively. Handles the
    real-world shapes: a single object, an array of objects, the
    ``@graph`` wrapper, and (importantly for product pages) nested
    entities like ``offers``/``brand``/``mainEntity`` that carry their
    own ``description`` and ``name`` fields."""
    if isinstance(data, dict):
        yield data
        for v in data.values():
            if isinstance(v, (dict, list)):
                yield from _iter_jsonld(v)
    elif isinstance(data, list):
        for item in data:
            yield from _iter_jsonld(item)


# Schema.org keys that typically carry the human-readable payload of a
# Product / Article / FAQPage / HowTo / Recipe / Course node. We pull
# every one we can find — duplicates are harmless because the chunker
# dedupes near-identical content downstream.
_JSONLD_TEXT_KEYS = (
    "name",
    "headline",
    "description",
    "articleBody",
    "text",
    "abstract",
    "alternativeHeadline",
)


def _stringify_jsonld_value(value: Any) -> list[str]:
    """JSON-LD values can be strings, lists, or further dicts (eg. an
    ``offers`` node). Walk recursively and pull the string leaves."""
    out: list[str] = []
    if isinstance(value, str):
        s = value.strip()
        if s:
            out.append(s)
    elif isinstance(value, list):
        for v in value:
            out.extend(_stringify_jsonld_value(v))
    elif isinstance(value, dict):
        for v in value.values():
            out.extend(_stringify_jsonld_value(v))
    return out


def _extract_structured_and_body(
    html: str, url: str
) -> tuple[str, str | None]:
    """Last-resort layer that doesn't care whether the page looks like an
    article. Pulls JSON-LD fields, OpenGraph metadata, ``<title>``, and
    a noise-stripped ``<body>`` text dump. This is what saves us on
    product pages, e-commerce listings, and JS-rendered SPAs whose
    payload doesn't fit trafilatura's article model."""
    del url  # currently unused, but kept in the signature for symmetry

    # lxml ships as a transitive dep of trafilatura, so this import is
    # effectively free. Guarded anyway so a stripped-down env still
    # degrades gracefully instead of crashing.
    try:
        from lxml import html as lxml_html  # noqa: PLC0415
    except ImportError:
        return "", None

    try:
        doc = lxml_html.fromstring(html)
    except Exception:  # noqa: BLE001 — lxml raises a zoo of exception types
        return "", None

    parts: list[str] = []
    title: str | None = None

    # Title: <title> first, then OpenGraph, then twitter:title.
    title_el = doc.find(".//title")
    if title_el is not None and (title_el.text or "").strip():
        title = title_el.text.strip()
    if not title:
        for xp in (
            '//meta[@property="og:title"]/@content',
            '//meta[@name="twitter:title"]/@content',
        ):
            vals = doc.xpath(xp)
            if vals and vals[0].strip():
                title = vals[0].strip()
                break

    # JSON-LD payload — the highest-quality structured content on most
    # modern product/article pages. Walk every <script type="application/ld+json">
    # tag and harvest the text-bearing keys.
    for script in doc.xpath('//script[@type="application/ld+json"]'):
        raw = (script.text_content() or "").strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            # Some sites emit invalid JSON-LD (trailing commas, comments).
            # Salvage what we can with a permissive regex on quoted fields.
            for key in _JSONLD_TEXT_KEYS:
                for m in re.finditer(rf'"{key}"\s*:\s*"([^"]+)"', raw):
                    parts.append(m.group(1).strip())
            continue
        for node in _iter_jsonld(data):
            for key in _JSONLD_TEXT_KEYS:
                if key in node:
                    parts.extend(_stringify_jsonld_value(node[key]))

    # Meta description / og:description as a low-cost backstop.
    for xp in (
        '//meta[@name="description"]/@content',
        '//meta[@property="og:description"]/@content',
    ):
        vals = doc.xpath(xp)
        if vals and vals[0].strip():
            parts.append(vals[0].strip())
            break

    # Now the cleaned <body> text. Strip script/style/nav/footer/etc.
    # before reading text content so we don't drown the signal in
    # cookie banners and footer chrome.
    for el in doc.xpath(
        "//script | //style | //noscript | //template | //iframe | //svg | "
        "//nav | //header | //footer | //aside | //form"
    ):
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)

    body = doc.find(".//body")
    if body is not None:
        body_text = " ".join(body.text_content().split())
        if len(body_text) >= BODY_TEXT_MIN:
            parts.append(body_text)

    text = "\n\n".join(p for p in parts if p)
    if len(text) > RAW_TEXT_CAP:
        text = text[:RAW_TEXT_CAP]
    return text, title


def _extract(html: str, url: str) -> tuple[str, str | None]:
    """Layered extraction. Try strategies from most-precise to
    most-permissive and take the first one with enough content. If none
    crosses :data:`MIN_CHARS` we still return the longest candidate so
    downstream code can decide what to do with it."""
    candidates: list[tuple[str, str | None]] = []

    # Layer 1 — precision-tuned trafilatura. Best for articles, docs,
    # blog posts. Strict, so it returns clean text or nothing.
    text, t1_title = _extract_with_trafilatura(html, url, favor_precision=True)
    if len(text) >= MIN_CHARS:
        return text, t1_title
    candidates.append((text, t1_title))

    # Layer 2 — recall-tuned trafilatura. Looser; catches docs pages
    # with sidebars, mixed layouts, multi-column posts that the
    # precision pass rejects.
    text2, t2_title = _extract_with_trafilatura(
        html, url, favor_precision=False, favor_recall=True
    )
    if len(text2) >= MIN_CHARS:
        return text2, t2_title or t1_title
    candidates.append((text2, t2_title))

    # Layer 3 — structured data + cleaned body. The bulk of real-world
    # product pages and rendered SPAs land here. Crucial for the
    # reviewer's "many product pages are JS-rendered" complaint.
    text3, t3_title = _extract_structured_and_body(html, url)
    if len(text3) >= MIN_CHARS:
        return text3, t3_title or t1_title or t2_title
    candidates.append((text3, t3_title))

    # Nothing crossed the threshold; return the longest non-empty
    # candidate so the caller can decide whether to escalate.
    best_text, best_title = max(candidates, key=lambda c: len(c[0]))
    return (
        best_text,
        best_title or t1_title or t2_title or t3_title,
    )


# ────────────────────────────────────────────────────────────────────────────
# Static + rendered scrape paths
# ────────────────────────────────────────────────────────────────────────────


def _is_recoverable_status(status: int) -> bool:
    """Decide whether a non-2xx response is worth retrying through a
    real browser. 403 frequently fires on bare httpx because the site
    runs Cloudflare / Akamai / PerimeterX bot detection — Chromium with
    proper headers usually passes. Everything else (auth-walled,
    not-found, gone, or 5xx) is terminal."""
    return status == 403


async def _scrape_static(url: str) -> tuple[str, str | None] | UrlScrapeError:
    """Static httpx + layered extraction.

    Returns ``(text, title)`` on success or a ``UrlScrapeError`` instance
    (returned, not raised) on a *recoverable* failure where the rendered
    fallback is worth trying. Hard failures (auth-walled, not-found,
    timeout, non-HTML) raise immediately because no renderer can fix
    them.
    """
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise UrlScrapeError("Only http(s) URLs are supported.")
    if not parsed.netloc:
        raise UrlScrapeError("URL is missing a hostname.")

    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=20.0,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": (
                    "text/html,application/xhtml+xml,application/xml;q=0.9,"
                    "image/webp,*/*;q=0.8"
                ),
                "Accept-Language": "en-US,en;q=0.9",
            },
        ) as client:
            resp = await client.get(url)
    except httpx.TimeoutException as exc:
        raise UrlScrapeError("Request timed out.") from exc
    except httpx.RequestError as exc:
        raise UrlScrapeError(f"Could not reach URL: {exc}") from exc

    if resp.status_code == 401:
        raise UrlScrapeError("The content is behind a login (HTTP 401).")
    if resp.status_code == 404:
        raise UrlScrapeError("Page not found (HTTP 404).")
    if resp.status_code == 410:
        raise UrlScrapeError("This page has been removed (HTTP 410).")
    if resp.status_code >= 400:
        if _is_recoverable_status(resp.status_code):
            # Most 403s on real product pages are bot blocks that a
            # headless browser bypasses. Hand back to the caller so it
            # can decide whether Playwright is enabled.
            return UrlScrapeError(
                f"Site returned HTTP {resp.status_code} to our request "
                "— it may be blocking non-browser clients."
            )
        raise UrlScrapeError(f"Site returned HTTP {resp.status_code}.")

    content_type = resp.headers.get("content-type", "").lower()
    if "html" not in content_type and "xml" not in content_type:
        raise UrlScrapeError(
            f"Unsupported content type: {content_type or 'unknown'}"
        )

    text, title = _extract(resp.text, url)
    if len(text) < MIN_CHARS:
        # Recoverable: hand back to caller so it can decide whether to
        # try the rendered fallback.
        return UrlScrapeError(
            "Extracted text was too short — the page may be JS-rendered, "
            "paywalled, or mostly non-article content."
        )
    return text, title


def _scrape_rendered_sync(url: str) -> tuple[str, str]:
    """Synchronous Playwright driver. Runs inside a worker thread so it
    works on Windows under uvicorn — see :func:`_scrape_rendered` for
    the rationale.

    Returns ``(html, page_title)`` so the async caller can run our
    layered extractor against the rendered DOM in the main thread
    (lxml/trafilatura don't need to be inside the worker thread).
    """
    # Lazy import so a missing install doesn't break module load.
    try:
        from playwright.sync_api import (  # noqa: PLC0415
            Error as PlaywrightError,
            sync_playwright,
        )
    except ImportError as exc:
        raise UrlScrapeError(
            "Playwright fallback requested but the package isn't installed. "
            "Run `pip install playwright && playwright install chromium`."
        ) from exc

    nav_timeout_ms = int(settings.playwright_navigation_timeout * 1000)
    # Bound the opportunistic networkidle wait so analytics-heavy pages
    # don't burn the full navigation budget.
    networkidle_timeout_ms = min(8_000, nav_timeout_ms)
    settle_ms = max(0, int(settings.playwright_settle_seconds * 1000))

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            context = browser.new_context(
                user_agent=USER_AGENT,
                locale="en-US",
                java_script_enabled=True,
                # Sensible defaults that look like a real desktop user.
                viewport={"width": 1280, "height": 900},
                extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
            )
            page = context.new_page()
            # Step 1: get the document parsed. Always reliable.
            page.goto(url, wait_until="domcontentloaded", timeout=nav_timeout_ms)
            # Step 2: best-effort wait for the network to quiet down.
            # Most product pages have late XHRs we want to capture, but
            # we never let this exceed the bounded budget above.
            try:
                page.wait_for_load_state(
                    "networkidle", timeout=networkidle_timeout_ms
                )
            except PlaywrightError:
                # Site never quiets down — that's fine, we already have
                # the rendered DOM from step 1.
                pass
            # Step 3: a brief paint-settle window for client-side
            # routers that hydrate after first paint.
            if settle_ms > 0:
                page.wait_for_timeout(settle_ms)
            html = page.content()
            page_title = page.title()
        finally:
            browser.close()

    return html, page_title


async def _scrape_rendered(url: str) -> tuple[str, str | None]:
    """Headless-browser path for JS-rendered sites and bot-blocked pages.

    Why a thread, not Playwright's async API:
    on Windows, uvicorn installs ``WindowsSelectorEventLoop`` for its
    socket I/O, but that loop *cannot launch subprocesses* — it raises
    ``NotImplementedError`` from ``asyncio.subprocess``. Playwright's
    async API needs to spawn a Chromium subprocess, so it dies on the
    first browser launch under uvicorn on Windows. The sync API uses
    plain ``subprocess.Popen`` which works everywhere; we just wrap it
    with :func:`asyncio.to_thread` so the rest of the app stays async.
    The cost is a single thread-pool worker per scrape — negligible
    for this workload.

    Wait strategy: we ``goto`` with ``domcontentloaded`` (always
    reliable and fast), then *opportunistically* poll for
    ``networkidle`` with a short budget — many real product pages have
    analytics/A-B-test pings that keep the network busy forever, so
    insisting on networkidle is a footgun. Finally a brief settle
    window catches late-bound JS that paints content after initial
    load completes.
    """
    try:
        html, page_title = await asyncio.to_thread(_scrape_rendered_sync, url)
    except UrlScrapeError:
        raise
    except Exception as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if "executable doesn't exist" in msg or "browsertype.launch" in msg:
            raise UrlScrapeError(
                "Headless browser isn't installed. Run "
                "`playwright install chromium` on the backend host."
            ) from exc
        if isinstance(exc, NotImplementedError):
            # The exact error we hit before moving Playwright into a
            # thread. Should never reach this branch now, but if it
            # ever does the operator deserves a useful message.
            raise UrlScrapeError(
                "Headless browser couldn't launch its subprocess "
                "(asyncio NotImplementedError). This usually means the "
                "event loop doesn't support subprocesses — switch to "
                "the Proactor loop or update Playwright."
            ) from exc
        # exc.__class__.__name__ keeps the error visible even when the
        # exception's str() is empty (eg. NotImplementedError() has no message).
        detail = str(exc) or exc.__class__.__name__
        raise UrlScrapeError(f"Headless browser failed: {detail}") from exc

    text, title = _extract(html, url)
    if not title and page_title:
        title = page_title.strip() or None

    if len(text) < MIN_CHARS:
        raise UrlScrapeError(
            "Even after rendering with a headless browser the page didn't "
            "expose a readable main article. It may require login, "
            "interaction, or have anti-bot protection."
        )
    return text, title


async def scrape_url(url: str) -> UrlResult:
    """Scrape ``url`` with the static path; fall back to a headless
    browser only if the static path failed in a recoverable way AND the
    operator has Playwright enabled.
    """
    static = await _scrape_static(url)

    rendered = False
    if isinstance(static, UrlScrapeError):
        if not settings.playwright_enabled:
            raise static
        logger.info(
            "url.scrape_static_failed_falling_back_to_playwright",
            url=url,
            reason=str(static),
        )
        text, title = await _scrape_rendered(url)
        rendered = True
    else:
        text, title = static

    parsed = urlparse(url)
    return UrlResult(
        text=text,
        title=title,
        url=url,
        char_count=len(text),
        domain=parsed.netloc,
        rendered=rendered,
    )

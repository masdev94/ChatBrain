"""URL scraping.

``trafilatura`` is purpose-built for extracting the main content of a web
page and is markedly better than readability/BeautifulSoup at filtering
navigation, footers, ads, and cookie banners. Its network layer
(`fetch_url`) is synchronous, so we do the HTTP fetch ourselves with
``httpx`` (so we can set a realistic User-Agent and a timeout) and then
hand the HTML to trafilatura for extraction.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

import httpx
import trafilatura

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15 ChatBrain/0.1"
)

MIN_CHARS = 200  # below this we assume extraction failed even if it "succeeded"


class UrlScrapeError(RuntimeError):
    """Raised with a human-readable reason when we can't scrape a URL."""


@dataclass
class UrlResult:
    text: str
    title: str | None
    url: str
    char_count: int
    domain: str


async def scrape_url(url: str) -> UrlResult:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise UrlScrapeError("Only http(s) URLs are supported.")
    if not parsed.netloc:
        raise UrlScrapeError("URL is missing a hostname.")

    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=20.0,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "en,*;q=0.5"},
        ) as client:
            resp = await client.get(url)
    except httpx.TimeoutException as exc:
        raise UrlScrapeError("Request timed out.") from exc
    except httpx.RequestError as exc:
        raise UrlScrapeError(f"Could not reach URL: {exc}") from exc

    if resp.status_code == 403:
        raise UrlScrapeError("The site blocked our request (HTTP 403).")
    if resp.status_code == 401:
        raise UrlScrapeError("The content is behind a login (HTTP 401).")
    if resp.status_code == 404:
        raise UrlScrapeError("Page not found (HTTP 404).")
    if resp.status_code >= 400:
        raise UrlScrapeError(f"Site returned HTTP {resp.status_code}.")

    content_type = resp.headers.get("content-type", "")
    if "html" not in content_type.lower() and "xml" not in content_type.lower():
        raise UrlScrapeError(f"Unsupported content type: {content_type or 'unknown'}")

    html = resp.text

    # trafilatura returns JSON so we can grab title + main content in one pass.
    extracted = trafilatura.extract(
        html,
        output_format="json",
        include_comments=False,
        include_tables=True,
        favor_precision=True,
        with_metadata=True,
        url=url,
    )

    if not extracted:
        raise UrlScrapeError("Couldn't find a readable main article on the page.")

    import json

    data = json.loads(extracted)
    text = (data.get("text") or "").strip()
    title = (data.get("title") or "").strip() or None

    if len(text) < MIN_CHARS:
        raise UrlScrapeError(
            "Extracted text was too short — the page may be JS-rendered, "
            "paywalled, or mostly non-article content."
        )

    return UrlResult(
        text=text,
        title=title,
        url=url,
        char_count=len(text),
        domain=parsed.netloc,
    )

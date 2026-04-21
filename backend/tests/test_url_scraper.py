"""URL scraper error handling and happy path (with mocked HTTP)."""

from __future__ import annotations

import httpx
import pytest
import respx

from app.ingestion.url import UrlScrapeError, scrape_url


ARTICLE_HTML = """
<!doctype html>
<html>
<head><title>Return Policy</title></head>
<body>
  <nav>Home · About · Contact</nav>
  <main>
    <article>
      <h1>Return Policy</h1>
      <p>We accept returns for damaged items within thirty days of purchase.
      Please contact support with your order number and a photo of the damage.</p>
      <p>Refunds are issued to the original payment method within five to seven
      business days after the returned item is received and inspected.</p>
      <p>Items used beyond inspection purposes are not eligible for refund.</p>
    </article>
  </main>
  <footer>Copyright 2026</footer>
</body></html>
"""


@respx.mock
async def test_scrape_happy_path_extracts_main_content() -> None:
    respx.get("https://example.com/policy").mock(
        return_value=httpx.Response(
            200,
            text=ARTICLE_HTML,
            headers={"content-type": "text/html; charset=utf-8"},
        )
    )

    result = await scrape_url("https://example.com/policy")

    assert "thirty days" in result.text
    assert "Copyright" not in result.text   # footer filtered
    assert "Home · About" not in result.text  # nav filtered
    assert result.title == "Return Policy"
    assert result.domain == "example.com"


@respx.mock
async def test_scrape_blocked_403_raises_with_message() -> None:
    respx.get("https://example.com/blocked").mock(
        return_value=httpx.Response(403, text="nope")
    )
    with pytest.raises(UrlScrapeError, match="blocked"):
        await scrape_url("https://example.com/blocked")


@respx.mock
async def test_scrape_behind_login_401_raises() -> None:
    respx.get("https://example.com/private").mock(
        return_value=httpx.Response(401, text="login required")
    )
    with pytest.raises(UrlScrapeError, match="login"):
        await scrape_url("https://example.com/private")


@respx.mock
async def test_scrape_404_raises() -> None:
    respx.get("https://example.com/missing").mock(
        return_value=httpx.Response(404, text="not found")
    )
    with pytest.raises(UrlScrapeError, match="not found"):
        await scrape_url("https://example.com/missing")


@respx.mock
async def test_scrape_non_html_raises() -> None:
    respx.get("https://example.com/data.json").mock(
        return_value=httpx.Response(
            200,
            text="{}",
            headers={"content-type": "application/json"},
        )
    )
    with pytest.raises(UrlScrapeError, match="Unsupported content type"):
        await scrape_url("https://example.com/data.json")


async def test_scrape_rejects_non_http_scheme() -> None:
    with pytest.raises(UrlScrapeError, match="http"):
        await scrape_url("ftp://example.com/thing")
